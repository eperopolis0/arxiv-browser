// ═══════════════════════════════════════════════════════
// arXiv cs.AI — Background Service Worker v1.0
// Fetches papers once daily, caches in storage.local.
// ═══════════════════════════════════════════════════════

const API_BASE = 'https://export.arxiv.org/api/query';
const HF_PAPERS_API = 'https://huggingface.co/api/daily_papers';
const LISTING_URL = 'https://arxiv.org/list/cs.AI/new';
const FALLBACK_COUNT = 300;    // Used if listing page is unavailable
const REQUEST_TIMEOUT = 60000; // 60s
const ALARM_NAME = 'arxiv-daily-fetch';

// ── Schedule ──────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[arXiv] Extension installed/updated. Clearing cache and reprocessing.');
  scheduleDailyAlarm();
  // Clear processedPapers so any code changes to clustering/scoring take effect immediately.
  // Also clear stale in-progress flags from the dead previous session.
  chrome.storage.local.set({ fetchInProgress: false, fetchStartedAt: null, processedPapers: [] }, () => doFetchAndCache());
});

// Fires when the browser itself starts — ensures we don't wait up to 60min for the alarm
chrome.runtime.onStartup.addListener(() => {
  console.log('[arXiv] Browser started. Checking for new papers.');
  scheduleDailyAlarm();
  // Same: previous service worker is gone, so any in-progress flag is stale
  chrome.storage.local.set({ fetchInProgress: false, fetchStartedAt: null }, () => doFetchAndCache());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    if (isFetchDay()) {
      console.log('[arXiv] Weekday alarm fired. Fetching papers.');
      doFetchAndCache();
    } else {
      console.log('[arXiv] Weekend — no new arXiv papers today. Skipping fetch.');
    }
  }
});

function scheduleDailyAlarm() {
  // Fire at midnight daily. arXiv posts at 8pm ET, so by midnight local time
  // papers have been up for hours and arXiv is no longer under peak load.
  // Always schedule for the NEXT midnight so we don't double-fire.
  const nextMidnight = new Date();
  nextMidnight.setDate(nextMidnight.getDate() + 1);
  nextMidnight.setHours(0, 0, 0, 0);
  const delayMs = nextMidnight.getTime() - Date.now();
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: delayMs / 60000,
    periodInMinutes: 24 * 60   // re-fires every 24h after that
  });
  console.log(`[arXiv] Alarm set for ${nextMidnight.toLocaleString()}`);
}

function isFetchDay() {
  // arXiv publishes Mon–Fri. Skip Sat (6) and Sun (0).
  const day = new Date().getDay();
  return day >= 1 && day <= 5;
}

// ── Messages from new tab page ─────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'refresh') {
    console.log('[arXiv] Manual refresh requested — clearing cache to force full fetch.');
    // Clear lastFetch and papers so doFetchAndCache does a real fetch.
    // Do NOT clear fetchInProgress here — let the concurrent-fetch guard in
    // doFetchAndCache handle deduplication. We only clear stale locks (>3min old).
    chrome.storage.local.set({ lastFetch: null, papers: [], fetchError: null }, () => {
      doFetchAndCache()
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
    });
    return true; // async response
  }
  if (msg.action === 'getStatus') {
    chrome.storage.local.get(['lastFetch', 'fetchError', 'paperCount', 'fetchInProgress'], sendResponse);
    return true;
  }
  if (msg.action === 'fetchHTMLPrestige') {
    fetchHTMLPrestige(msg.arxivId)
      .then(tier => sendResponse({ tier }))
      .catch(() => sendResponse({ tier: null }));
    return true; // async response
  }
});

// ── Fetch & Cache ─────────────────────────────────────

async function doFetchAndCache() {
  // Respect 429 cooldown — if we were recently rate-limited, bail until the
  // cooldown expires.  The newtab polling loop drives the retry once it expires.
  const { fetchRetryAfter } = await getStorage(['fetchRetryAfter']);
  if (fetchRetryAfter && Date.now() < fetchRetryAfter) {
    const secsLeft = Math.ceil((fetchRetryAfter - Date.now()) / 1000);
    console.log(`[arXiv] Rate limit cooldown active — ${secsLeft}s remaining. Skipping.`);
    return;
  }

  // Prevent concurrent fetches
  const { fetchInProgress, fetchStartedAt } = await getStorage(['fetchInProgress', 'fetchStartedAt']);
  const now = Date.now();
  if (fetchInProgress && fetchStartedAt && (now - fetchStartedAt) < 3 * 60 * 1000) {
    console.log('[arXiv] Fetch already in progress. Skipping.');
    return;
  }

  // Check if we already have fresh data for today
  const { lastFetch, papers, processedPapers } = await getStorage(['lastFetch', 'papers', 'processedPapers']);
  const today = new Date().toISOString().slice(0, 10);
  if (lastFetch === today && papers?.length > 0) {
    if (!processedPapers?.length) {
      console.log(`[arXiv] Papers already fetched for today but processedPapers missing — re-processing.`);
      await processAndStore(papers);
      chrome.runtime.sendMessage({ action: 'dataUpdated' }).catch(() => {});
    } else {
      console.log(`[arXiv] Already have ${papers.length} papers for today. Skipping.`);
    }
    return;
  }

  await setStorage({ fetchInProgress: true, fetchStartedAt: now, fetchError: null });
  console.log('[arXiv] Fetch started.');

  try {
    // Get today's exact paper count + HF trending in parallel
    const [hfTrending, count] = await Promise.all([
      fetchHFTrending(),
      fetchTodayCount()
    ]);
    const rawPapers = await fetchArxivBatch(count);

    // No date filter — we already fetch exactly `count` papers from today's listing,
    // so all rawPapers are today's batch. The `updated` field in arXiv's Atom feed
    // is the author's last revision date (e.g. Friday for a paper announced Monday),
    // not arXiv's announcement date, so a cutoff filter incorrectly removes everything
    // on Mondays and after long weekends.
    const freshPapers = rawPapers;

    // S2 affiliation lookup — non-fatal; missing → prestige 2 (neutral)
    const prestigeMap = await fetchS2Affiliations(freshPapers);

    // Cross-reference HF trending + prestige
    const allEnriched = freshPapers.map(p => {
      const hf = hfTrending.get(p.arxivId);
      return {
        ...p,
        trending: !!hf,
        upvotes: hf?.upvotes || 0,
        prestige: prestigeMap.get(p.arxivId.replace(/v\d+$/, '')) ?? null,
      };
    });

    const enriched = allEnriched;

    await setStorage({
      papers: enriched,
      lastFetch: today,
      fetchError: null,
      fetchRetryAfter: null, // clear any previous rate-limit cooldown
      paperCount: enriched.length,
      fetchInProgress: false,
      fetchStartedAt: null
    });

    console.log(`[arXiv] Cached ${enriched.length} papers for ${today}.`);

    // Process papers (scoring + clustering) and store result so new tab renders instantly
    await processAndStore(enriched);

    chrome.runtime.sendMessage({ action: 'dataUpdated' }).catch(() => {});

  } catch (err) {
    console.error('[arXiv] Fetch failed:', err.message);
    const is429 = err.message.includes('429');
    const is503 = err.message.includes('503');
    // 429: 3-min cooldown (rate limit). 503: 45s retry (arXiv overloaded, common
    // on Monday mornings when papers drop). Both use fetchRetryAfter so newtab
    // shows a countdown and auto-retries rather than leaving the user stuck.
    const retryDelay = is429 ? 3 * 60 * 1000 : is503 ? 45 * 1000 : 0;
    await setStorage({
      fetchError: err.message,
      fetchInProgress: false,
      fetchStartedAt: null,
      ...(retryDelay ? { fetchRetryAfter: Date.now() + retryDelay } : {})
    });
  }
}

// Fetch today's paper count from the listing page heading.
// e.g. "Fri, 20 Mar 2026 (showing first 50 of 228 entries)"
async function fetchTodayCount() {
  try {
    const resp = await fetchWithTimeout(LISTING_URL, 15000);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    // The listing page has three sections in order:
    //   New submissions (showing N of N entries)
    //   Cross-listings  (showing N of N entries)
    //   Replacements    (showing N of N entries)
    // We want New + Cross-listings, not Replacements.
    const re = /showing\s+(?:first\s+)?\d+\s+of\s+(\d+)\s+entr/gi;
    const matches = [...html.matchAll(re)];
    if (matches.length >= 2) {
      const count = parseInt(matches[0][1], 10) + parseInt(matches[1][1], 10);
      console.log(`[arXiv] Listing: ${matches[0][1]} new + ${matches[1][1]} cross-listed = ${count} total.`);
      return count;
    } else if (matches.length === 1) {
      const count = parseInt(matches[0][1], 10);
      console.log(`[arXiv] Listing: ${count} papers (single section).`);
      return count;
    }
    throw new Error('count not found in listing page');
  } catch (e) {
    console.warn(`[arXiv] Listing page failed (${e.message}), falling back to ${FALLBACK_COUNT}`);
    return FALLBACK_COUNT;
  }
}

async function fetchArxivBatch(count) {
  // Fetch cs.AI only. arXiv's cat:cs.AI query returns every paper listed in
  // arxiv.org/list/cs.AI/new — including cross-listed papers from other cs.* categories.
  // Request exactly the listing page count — no buffer, since any excess is
  // filled with previous-day papers that shouldn't be shown.
  const params = new URLSearchParams({
    search_query: 'cat:cs.AI',
    start: 0,
    max_results: count,
    sortBy: 'submittedDate',
    sortOrder: 'descending'
  });

  // Fetch once. If rate-limited, throw immediately so doFetchAndCache can store
  // a fetchRetryAfter cooldown timestamp. The newtab page drives the retry
  // countdown — service workers can be killed after ~30s of inactivity so
  // long sleeps here are unreliable.
  console.log(`[arXiv] Fetching ${count} cs.AI papers…`);
  const resp = await fetchWithTimeout(`${API_BASE}?${params}`, REQUEST_TIMEOUT);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const xml = await resp.text();
  const papers = parseAtomXML(xml);
  console.log(`[arXiv] cs.AI: ${papers.length} papers fetched.`);
  return papers;
}

async function fetchHFTrending() {
  const map = new Map();
  try {
    const resp = await fetchWithTimeout(HF_PAPERS_API, 15000);
    if (!resp.ok) return map;
    const data = await resp.json();
    data.forEach(item => {
      const id = item.paper?.id;
      if (id) map.set(id, { upvotes: item.numUpvotes || 0 });
    });
    console.log(`[arXiv] HF trending: ${map.size} papers.`);
  } catch (e) {
    console.warn('[arXiv] HF trending failed (non-fatal):', e.message);
  }
  return map;
}

// ═══════════════════════════════════════════════════════
// PRESTIGE — Semantic Scholar affiliation lookup
// ═══════════════════════════════════════════════════════
// Optional API key — register free at https://www.semanticscholar.org/product/api
// Leave null to use unauthenticated (1 req/day fine; add key if rate-limited).
const S2_API_KEY = null;
const S2_BATCH_URL = 'https://api.semanticscholar.org/graph/v1/paper/batch';

// Tier 3 — Frontier labs, elite CS/AI universities, major government research (dot 1.5× size)
const PRESTIGE_TIER3 = [
  // Frontier AI labs
  'deepmind','google brain','google research','google ai',
  'openai','anthropic',
  'meta ai','fundamental ai research','meta platforms',
  'microsoft research',
  'nvidia research',
  'apple machine learning','apple ai research',
  'hugging face',
  'xai','x.ai',
  'amazon science',
  // Government & national labs (US)
  'darpa','defense advanced research projects',
  'national institute of standards','nist',
  'national security agency',
  'argonne national laboratory',
  'oak ridge national laboratory',
  'lawrence berkeley national laboratory',
  'lawrence livermore national laboratory',
  'sandia national',
  'los alamos national laboratory',
  'pacific northwest national laboratory',
  'national institutes of health',
  'air force research laboratory','afrl',
  'army research laboratory',
  'naval research laboratory',
  'intelligence advanced research projects',
  // Government & national labs (international)
  'alan turing institute',
  'fraunhofer',
  'inria',
  'riken',
  'chinese academy of sciences',
  // Elite universities (CS/AI)
  'massachusetts institute of technology',
  'stanford university','stanford ai lab',
  'carnegie mellon university',
  'university of california, berkeley','uc berkeley','berkeley artificial intelligence',
  'california institute of technology','caltech',
  'university of oxford',
  'university of cambridge',
  'eth zurich','eth zürich',
  'epfl','école polytechnique fédérale de lausanne',
  'mila','université de montréal','university of toronto',
  'princeton university',
  'max planck institute',
  'tsinghua university','tsinghua',
  'peking university',
];

// Tier 2 — Strong research universities + secondary labs (current/default size)
const PRESTIGE_TIER2 = [
  'new york university','cornell university','columbia university',
  'university of michigan','university of washington',
  'georgia institute of technology','georgia tech',
  'university of illinois','university of texas',
  'university of maryland',
  'university of california',          // catches UCSD, UCLA, UCSB etc.
  'university of pennsylvania',
  'johns hopkins university',
  'university of edinburgh','imperial college',
  'university college london',
  'national university of singapore',
  'nanyang technological university',
  'zhejiang university','shanghai jiao tong','fudan university',
  'kaist','seoul national university',
  'technical university of munich','technische universität münchen',
  'ku leuven','vrije universiteit',
  'adobe research','ibm research',
  'samsung research','sony research',
  'baidu research','alibaba damo','bytedance research',
  'salesforce research',
  'allen institute',
];

// Email domains for fetchHTMLPrestige scan.
const EMAIL_DOMAIN_TIER3 = [
  'google.com','deepmind.com','anthropic.com','openai.com',
  'meta.com','microsoft.com','nvidia.com','apple.com',
  'amazon.com','huggingface.co',
];
const EMAIL_DOMAIN_TIER2 = [
  'nyu.edu','cornell.edu','columbia.edu','cmu.edu','mit.edu',
  'stanford.edu','berkeley.edu','uw.edu','gatech.edu',
  'illinois.edu','utexas.edu','umd.edu','upenn.edu',
  'jhu.edu','ed.ac.uk','ic.ac.uk','ucl.ac.uk',
  'nus.edu.sg','ntu.edu.sg','tum.de',
  'adobe.com','ibm.com','samsung.com','sony.com',
  'baidu.com','alibaba-inc.com','bytedance.com','salesforce.com',
];

// On-click prestige scan: fetch the first 64KB of the arxiv latexml HTML version.
// The CSS preamble is typically 20–40KB; 64KB reliably reaches the author block.
// ltx_role_affiliation spans only appear in the authors section — safe from citation pollution.
// Returns 3, 2, 1 (confirmed), or null (no HTML version or no affiliation data found).
async function fetchHTMLPrestige(arxivId) {
  const url = `https://arxiv.org/html/${arxivId}`;
  let text;
  try {
    const resp = await fetchWithTimeout(url, 15000, {
      headers: { Range: 'bytes=0-65535' }
    });
    if (resp.status !== 200 && resp.status !== 206) return null;
    text = await resp.text();
  } catch (e) {
    console.warn(`[Prestige] Fetch failed for ${arxivId}: ${e.message}`);
    return null;
  }

  let affiliationText = '';
  const affRe = /<span[^>]*ltx_role_affiliation[^>]*>([\s\S]*?)<\/span>/gi;
  let affM;
  while ((affM = affRe.exec(text)) !== null) {
    affiliationText += ' ' + affM[1].replace(/<[^>]+>/g, ' ');
  }
  // Fallback: small window of ltx_authors block (800 chars — stays in front matter).
  if (!affiliationText.trim()) {
    const authM = /class="[^"]*ltx_authors[^"]*"[^>]*>([\s\S]{0,800})/i.exec(text);
    if (authM) affiliationText = authM[1].replace(/<[^>]+>/g, ' ');
  }

  const emailMatches = text.match(/href="mailto:[^"]+"/gi) || [];
  const emailText = emailMatches.join(' ');

  if (!affiliationText.trim() && !emailText) return null;

  const scanText = (affiliationText + ' ' + emailText).toLowerCase();

  for (const t of PRESTIGE_TIER3) { if (scanText.includes(t)) return 3; }
  for (const d of EMAIL_DOMAIN_TIER3) { if (scanText.includes('@' + d)) return 3; }
  for (const t of PRESTIGE_TIER2) { if (scanText.includes(t)) return 2; }
  for (const d of EMAIL_DOMAIN_TIER2) { if (scanText.includes('@' + d)) return 2; }
  return 1; // affiliation found but no notable institution — confirmed Independent
}

// Thresholds for author citation count → tier.
// Any author on the paper with citations above the tier-3 threshold bumps the
// paper to tier 3; similarly for tier 2. Affiliations are checked first and
// take priority when S2 has them.
// Citation count → tier 2 only. Tier 3 is reserved for abstract text matches
// (explicit frontier lab mention). Citation count can't distinguish a particle
// physicist with 10k citations from an AI researcher at Google — too noisy for ★★★.
const CITE_TIER2 = 800;    // active researcher with a real publication track record

// Score using S2 affiliations + citation count → tier 1 or 2 only (never 3).
// Tier 3 is assigned by scorePrestigeFromAbstract() in processAndStore.
function scorePrestige(affiliations, maxCitations) {
  if (affiliations?.length) {
    const text = affiliations.join(' ').toLowerCase();
    // Affiliation matches tier 3 list → still only return 2 from S2 path.
    // The abstract scan in processAndStore will upgrade to 3 if warranted.
    for (const t of PRESTIGE_TIER3) { if (text.includes(t)) return 2; }
    for (const t of PRESTIGE_TIER2) { if (text.includes(t)) return 2; }
  }
  if (maxCitations >= CITE_TIER2) return 2;
  if (affiliations?.length) return 1;
  return null; // no S2 data — caller defaults to 1
}

async function fetchS2Affiliations(papers) {
  const prestigeMap = new Map();
  if (!papers.length) return prestigeMap;

  // Batch up to 500 arxiv IDs per S2 request.
  // Request both affiliations (for lab matching) and citationCount (fallback).
  // Strip version suffix (e.g. "2503.12345v1" → "2503.12345") — S2 rejects versioned IDs with HTTP 400.
  const ids = papers.map(p => `ARXIV:${p.arxivId.replace(/v\d+$/, '')}`);
  const chunks = [];
  for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));

  for (const chunk of chunks) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (S2_API_KEY) headers['x-api-key'] = S2_API_KEY;

      const resp = await fetchWithTimeout(
        S2_BATCH_URL + '?fields=authors.affiliations,authors.citationCount', 30000,
        { method: 'POST', headers, body: JSON.stringify({ ids: chunk }) }
      );
      if (!resp.ok) {
        console.warn(`[S2] Batch failed: HTTP ${resp.status} — prestige defaults to 2`);
        break;
      }

      const data = await resp.json();
      let matched = 0;
      data.forEach((paper, i) => {
        if (!paper) return;
        const arxivId = chunk[i].replace('ARXIV:', '');
        const authors = paper.authors || [];
        const allAffiliations = authors.flatMap(a => (a.affiliations || []).map(af => af.name || af));
        const maxCitations = Math.max(0, ...authors.map(a => a.citationCount || 0));
        const tier = scorePrestige(allAffiliations, maxCitations);
        if (tier !== null) { prestigeMap.set(arxivId, tier); matched++; }
      });
      console.log(`[S2] Scored ${matched}/${data.length} papers (affiliations + citation count).`);
    } catch (e) {
      console.warn(`[S2] Fetch failed (${e.message}) — prestige defaults to 2`);
    }
  }

  return prestigeMap;
}

// ── Helpers ───────────────────────────────────────────

function fetchWithTimeout(url, ms, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Regex-based Atom parser — no DOMParser needed (not available in Brave SW)
function parseAtomXML(xml) {
  const papers = [];

  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const e = m[1];

    const id = (/<id[^>]*>\s*([\s\S]*?)\s*<\/id>/.exec(e) || [])[1] || '';
    const arxivId = id.replace('http://arxiv.org/abs/', '').trim();

    const published = (/<published[^>]*>([\s\S]*?)<\/published>/.exec(e) || [])[1]?.trim() || '';
    const updated   = (/<updated[^>]*>([\s\S]*?)<\/updated>/.exec(e)   || [])[1]?.trim() || '';

    const title = xmlText(/<title[^>]*>([\s\S]*?)<\/title>/.exec(e));
    const summary = xmlText(/<summary[^>]*>([\s\S]*?)<\/summary>/.exec(e));

    const authors = [];
    const nameRe = /<name>([\s\S]*?)<\/name>/g;
    let nm;
    while ((nm = nameRe.exec(e)) !== null) authors.push(nm[1].trim());

    const categories = [];
    const catRe = /<category[^>]*\bterm="([^"]+)"/g;
    let cm;
    while ((cm = catRe.exec(e)) !== null) categories.push(cm[1]);

    // PDF link: <link ... title="pdf" ... href="...">
    const pdfM = /<link[^>]*title="pdf"[^>]*href="([^"]+)"/.exec(e)
              || /<link[^>]*href="([^"]+)"[^>]*title="pdf"/.exec(e);
    const pdfLink = pdfM ? pdfM[1] : `https://arxiv.org/pdf/${arxivId}`;

    if (arxivId && title) {
      papers.push({
        arxivId, title, summary, published, updated,
        authors, categories, pdfLink,
        absLink: `https://arxiv.org/abs/${arxivId}`,
        trending: false, upvotes: 0
      });
    }
  }
  return papers;
}

function xmlText(match) {
  if (!match) return '';
  return match[1]
    .replace(/\s+/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setStorage(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

// ═══════════════════════════════════════════════════════
// PAPER PROCESSING — runs in background after fetch so
// the new tab page can render instantly from stored results
// ═══════════════════════════════════════════════════════

function classifyFormat(title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  if (/\b(benchmark|dataset|leaderboard|evaluation suite|corpus|annotated)\b/.test(text)) return 'benchmark';
  if (/\b(survey|overview|review|tutorial|comprehensive study|systematic review)\b/.test(text)) return 'survey';
  if (/\b(theorem|lemma|proof|regret bound|sample complexity|convergence rate|upper bound|lower bound|pac learning|information.theoretic|complexity analysis|formal(ly| proof)|provably)\b/.test(text)) return 'theory';
  if (/\b(position paper|we argue|we contend|we call for|we urge|manifesto|perspective|opinion)\b/.test(text)) return 'position';
  return 'empirical';
}

function scoreApplied(title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  const aTerms = ['deploy','real-world','production','industry','application','practical','clinical','medical','healthcare','commercial','on-device','edge','robot','autonomous','user study','human evaluation','user interface','open-source','open source','released','api','pipeline','end-to-end system','in the wild'];
  const tTerms = ['theorem','lemma','proof','regret','sample complexity','convergence rate','upper bound','lower bound','pac learning','formal','asymptotic','theoretical analysis','minimax','information-theoretic'];
  const a = aTerms.filter(t => text.includes(t)).length;
  const th = tTerms.filter(t => text.includes(t)).length;
  // Base 0.38 (slight theory-lean) so neutral papers don't pile up at centre.
  return Math.min(1, Math.max(0, 0.38 + a * 0.11 - th * 0.15));
}

function scoreRelevance(cat, title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  // Genuinely exciting to a builder following the AI frontier
  const hi = ['agent','multimodal','reasoning','language model','llm','alignment','rlhf','instruction follow','world model','chain-of-thought','in-context','emergent'];
  // Solid but routine ML work
  const mid = ['classification','detection','segmentation','benchmark','fine-tun','transfer','distill'];
  // Very niche / low relevance to AI builders
  const lo = ['sodium','battery','chemical','material','crystal','protein','genomic','fluid','quantum circuit','routing protocol'];
  const h = hi.filter(t => text.includes(t)).length;
  const m = mid.filter(t => text.includes(t)).length;
  const l = lo.filter(t => text.includes(t)).length;
  // Smaller per-category boost so scores actually spread across the y-axis
  const boost = ['cs.AI','cs.CL'].includes(cat) ? 0.05 : 0;
  return Math.min(1, Math.max(0.05, 0.35 + h * 0.10 + m * 0.03 - l * 0.15 + boost));
}

const STOPWORDS = new Set(['a','an','the','in','on','at','to','for','of','with','and','or','is','are','was','were','this','that','these','those','we','our','it','its','by','from','as','be','been','has','have','had','not','but','which','also','can','using','based','via','paper','propose','model','method','approach','show','shows','learn','learning','deep','new','two','one','three','large','small','high','low','first','present','achieve','result','performance','training','train','trained','task','tasks','data','dataset','set','use','used','different','across','between','both','more','than','without','into','each','other','such','whether','while','when','where','then','their','they','them','thus','however','here','there']);

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(t => t.length > 3 && !STOPWORDS.has(t));
}

function buildTFIDF(papers) {
  const docs = papers.map(p => tokenize(p.title + ' ' + (p.summary || '')));
  const N = docs.length;
  const df = {};
  docs.forEach(tokens => new Set(tokens).forEach(t => df[t] = (df[t]||0)+1));
  const vocab = Object.keys(df)
    .filter(t => df[t] >= 2 && df[t] <= N / 2)
    .sort((a,b) => Math.log((N+1)/(df[b]+1)) - Math.log((N+1)/(df[a]+1)))
    .slice(0, 400);
  const vi = {};
  vocab.forEach((t,i) => vi[t] = i);
  const idf = t => Math.log((N+1)/(df[t]+1));
  const vectors = docs.map(tokens => {
    const freq = {};
    tokens.forEach(t => freq[t] = (freq[t]||0)+1);
    const maxF = Math.max(...Object.values(freq), 1);
    const vec = new Float32Array(vocab.length);
    Object.entries(freq).forEach(([t,f]) => { if (vi[t] !== undefined) vec[vi[t]] = (f/maxF)*idf(t); });
    const norm = Math.sqrt(vec.reduce((s,x) => s+x*x, 0)) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  });
  return { vectors, vocab };
}

function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]*b[i];
  return dot;
}

function kmeansCluster(vectors, k = 12, maxIter = 25) {
  if (!vectors.length) return new Int32Array(0);
  const n = vectors.length, dim = vectors[0].length;
  k = Math.min(k, n);
  let s = 42;
  const rng = () => { s=(s*1664525+1013904223)&0xffffffff; return (s>>>0)/0xffffffff; };
  const centroids = [vectors[Math.floor(rng()*n)]];
  while (centroids.length < k) {
    const dists = vectors.map(v => 1 - Math.max(0, ...centroids.map(c => cosineSim(v,c))));
    const sum = dists.reduce((a,b)=>a+b, 0);
    let r = rng() * sum;
    let picked = false;
    for (let i = 0; i < n; i++) { r -= dists[i]; if (r <= 0) { centroids.push(vectors[i]); picked = true; break; } }
    if (!picked) centroids.push(vectors[Math.floor(rng()*n)]);
  }
  const assignments = new Int32Array(n);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bestSim = -Infinity;
      for (let j = 0; j < k; j++) { const sim = cosineSim(vectors[i], centroids[j]); if (sim > bestSim) { bestSim = sim; best = j; } }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    if (!changed) break;
    for (let j = 0; j < k; j++) {
      const c = new Float32Array(dim);
      let cnt = 0;
      for (let i = 0; i < n; i++) if (assignments[i] === j) { for (let d = 0; d < dim; d++) c[d] += vectors[i][d]; cnt++; }
      if (!cnt) continue;
      const norm = Math.sqrt(c.reduce((s,x)=>s+x*x,0))||1;
      for (let d = 0; d < dim; d++) centroids[j][d] = c[d]/norm;
    }
  }
  return assignments;
}

const CLUSTER_MAP = [
  { name:'Agents & Planning',        keys:['agent','agentic','multi-agent','autonomous agent','tool use','tool call','planning','workflow','orchestrat','chain-of-thought','reasoning trace','decision mak'] },
  { name:'Safety & Alignment',       keys:['safety','alignment','harmful','jailbreak','red team','toxicity','bias','fairness','watermark','adversarial','privacy','decepti','misinform','hallucin','trustworth','robust'] },
  { name:'Image & Video Generation', keys:['image generation','video generation','diffusion model','text-to-image','text-to-video','inpaint','outpaint','image synthesis','video synthesis','gan','generative adversarial','stable diffusion','denoising'] },
  { name:'Visual Understanding',     keys:['visual question','vqa','image caption','visual grounding','scene understand','multimodal','vision-language','vlm','visual reasoning','image-text','chart understand','document understand'] },
  { name:'Vision: Detection',        keys:['object detect','instance segment','semantic segment','bounding box','yolo','detr','panoptic','depth estimat','pose estimat','3d reconstruction','point cloud','lidar','nerf'] },
  { name:'Reinforcement Learning',   keys:['reinforcement learn','reward model','policy gradient','value function','q-learning','ppo','actor-critic','offline rl','exploration','bandit','markov','mcts','game play'] },
  { name:'Robotics & Embodied',      keys:['robot','manipulation','gripper','locomotion','embodied','sim-to-real','dexterous','imitation learn','motor control','navigation','autonomous driv'] },
  { name:'Audio & Speech',           keys:['speech recognit','speech synthesis','speech emotion','emotion recognit','text-to-speech','speaker verif','speaker diariz','audio classif','audio-language','audio model','sound event','music generat','acoustic model','asr','tts','voice conver','codec','prosody','audio','sound','music','speaker'] },
  { name:'Time Series & Signals',    keys:['time series','forecasting','temporal','anomaly detect','sensor','signal process','streaming','event stream','sequential data'] },
  { name:'Language & Translation',   keys:['machine translat','multilingual','low-resource','cross-lingual','nmt','tokeniz','morpholog','dialect','language transfer','bilingual'] },
  { name:'Efficiency & Compression', keys:['quantiz','pruning','distillation','compression','efficient','lightweight','mobile','edge deploy','inference speed','throughput','latency','hardware','sparsity'] },
  { name:'Fine-tuning & Adaptation', keys:['fine-tun','finetun','lora','peft','prompt tuning','adapter','instruction tuning','sft','rlhf','merging','few-shot','zero-shot adaptation','parameter-efficient'] },
  { name:'Retrieval & Knowledge',    keys:['retrieval augment','rag','knowledge graph','information retrieval','entity','relation extract','knowledge base','dense retrieval','rerank','index'] },
  { name:'Foundation Models',        keys:['pretrain','foundation model','scaling law','large language model','llm','gpt','bert','llama','transformer architecture','attention mechanism','self-supervised','contrastive learn'] },
];

// Classify a single paper directly against CLUSTER_MAP keyword lists.
// This is deterministic — same paper always gets the same label — so
// category names stay stable across days instead of varying with k-means.
// Falls back to a category-based bucket for papers that don't match any list.
function classifyPaper(title, summary, cat) {
  const text = (title + ' ' + summary).toLowerCase();
  let best = null, bestScore = 0;
  for (const { name, keys } of CLUSTER_MAP) {
    const score = keys.filter(k => text.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = name; }
  }
  return best || 'General ML';
}

// Scan title + abstract for explicit frontier lab mentions.
// Papers FROM these labs almost always name themselves in the abstract.
// Papers merely ABOUT them (e.g. "we evaluate GPT-4") may also match —
// that's acceptable; those papers are still highly relevant.
const ABSTRACT_TIER3 = [
  'google deepmind','google brain','google research','google ai',
  // 'openai' alone is too broad — catches any paper evaluating GPT-4.
  // Require phrasing that strongly implies authorship rather than mere use.
  'openai research','openai alignment','openai safety','we at openai',
  'anthropic',
  'meta ai','fundamental ai research','meta fair',
  'microsoft research',
  'nvidia research',
  'apple machine learning','apple intelligence research',
  'deepmind',
  'amazon science',
  // xai (Elon's lab) is indistinguishable from "explainable AI (XAI)" in abstracts — omitted.
  // Government / national labs
  'darpa','defense advanced research projects',
  'national institute of standards and technology',
  'argonne national','oak ridge national','lawrence berkeley national',
  'lawrence livermore national','sandia national','los alamos national',
  'pacific northwest national',
  'intelligence advanced research projects',
  'alan turing institute',
  'fraunhofer','inria','riken',
  'chinese academy of sciences',
];

function scorePrestigeFromAbstract(title, summary) {
  const text = (title + ' ' + (summary || '')).toLowerCase();
  for (const t of ABSTRACT_TIER3) { if (text.includes(t)) return 3; }
  for (const t of PRESTIGE_TIER2) { if (text.includes(t)) return 2; }
  return null; // no match — starts as unverified, HTML scan fills in later
}

async function processAndStore(rawPapers) {
  if (!rawPapers?.length) {
    console.warn('[arXiv] processAndStore called with 0 papers — skipping.');
    return;
  }
  console.log(`[arXiv] Processing ${rawPapers.length} papers…`);
  const papers = rawPapers.map(p => {
    const cat = (p.categories || []).find(c => c.startsWith('cs.')) || p.categories?.[0] || 'cs.AI';
    const cluster = classifyPaper(p.title, p.summary || '', cat);
    const abstractTier = scorePrestigeFromAbstract(p.title, p.summary || '');
    // Abstract scan takes priority; S2 prestige fills in what abstract misses; null = unverified.
    const prestige = abstractTier ?? p.prestige ?? null;
    return {
      id:        p.arxivId,
      title:     p.title,
      gist:      (p.summary || '').slice(0, 200).replace(/\s+/g,' ').toLowerCase(),
      cat,
      format:    classifyFormat(p.title, p.summary || ''),
      applied:   scoreApplied(p.title, p.summary || ''),
      relevance: scoreRelevance(cat, p.title, p.summary || ''),
      upvotes:   p.upvotes || 0,
      trending:  p.trending || false,
      prestige,  // 1=unknown 2=research 3=frontier
      starred:   false,
      clusters:  [cluster],
      _absLink:   p.absLink  || `https://arxiv.org/abs/${p.arxivId}`,
      _pdfLink:   p.pdfLink  || `https://arxiv.org/pdf/${p.arxivId}`,
      _authors:   (p.authors || []).slice(0,3).join(', '),
      _summary:   p.summary || '',
      _published: (p.published || '').slice(0, 10), // YYYY-MM-DD submission date
      _updated:   (p.updated   || p.published || '').slice(0, 10), // YYYY-MM-DD announcement date
    };
  });

  const clusterCounts = {};
  papers.forEach(p => { const c = p.clusters[0]; clusterCounts[c] = (clusterCounts[c]||0)+1; });
  const t3 = papers.filter(p => p.prestige === 3).length;
  const t2 = papers.filter(p => p.prestige === 2).length;
  await setStorage({ processedPapers: papers });
  console.log(`[arXiv] Stored ${papers.length} papers. Prestige: ★★★${t3} ★★${t2} ★${papers.length-t3-t2}. Clusters: ${Object.entries(clusterCounts).map(([k,v])=>`${k}(${v})`).join(', ')}`);
}
