// ═══════════════════════════════════════════════════════
// arXiv cs.AI — Background Service Worker v1.0
// Fetches papers once daily, caches in storage.local.
// ═══════════════════════════════════════════════════════

function stripLatex(text) {
  if (!text) return text;
  return text
    .replace(/\\(?:emph|textbf|textit|texttt|text|mathrm|mathbf|mathit)\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+\s*/g, '')
    .replace(/[{}]/g, '');
}

const API_BASE = 'https://export.arxiv.org/api/query';
const LISTING_URL = 'https://arxiv.org/list/cs.AI/new';
const FALLBACK_COUNT = 150;    // Used if listing page is unavailable (conservative — better to miss a few than show old papers)
const REQUEST_TIMEOUT = 60000; // 60s
const ALARM_NAME = 'arxiv-daily-fetch';

// ── Schedule ──────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[arXiv] Extension installed/updated. Clearing cache and reprocessing.');
  scheduleDailyAlarm();
  // Clear processedPapers so any code changes to clustering/scoring take effect immediately.
  // Also clear stale in-progress flags from the dead previous session.
  chrome.storage.local.set({ fetchInProgress: false, fetchStartedAt: null, processedPapers: [], scoreStats: null, scoreStatsLastDate: null }, () => doFetchAndCache());
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
    // Fetch listing IDs and pre-scored JSON in parallel.
    const [{ count, ids: listingIds }, preScored] = await Promise.all([
      fetchTodayListing(),
      fetchPreScoredJSON(today),
    ]);
    const rawPapers = await fetchArxivBatch(count, listingIds);

    // When fetched by id_list, rawPapers are already exactly today's papers.
    // Falls back to date filter if listing page was unavailable.
    let freshPapers;
    if (listingIds?.size) {
      freshPapers = rawPapers;
    } else {
      const latestDate = rawPapers
        .map(p => (p.updated || p.published || '').slice(0, 10))
        .filter(Boolean).sort().at(-1);
      freshPapers = latestDate
        ? rawPapers.filter(p => (p.updated || p.published || '').slice(0, 10) === latestDate)
        : rawPapers;
      console.log(`[arXiv] Date fallback filter (${latestDate}): ${rawPapers.length} → ${freshPapers.length} papers`);
    }

    const enriched = freshPapers.map(p => ({ ...p, prestige: null }));

    await setStorage({
      papers: enriched,
      lastFetch: today,
      lastFetchTime: Date.now(),
      fetchError: null,
      fetchRetryAfter: null,
      paperCount: enriched.length,
      fetchInProgress: false,
      fetchStartedAt: null
    });

    console.log(`[arXiv] Cached ${enriched.length} papers for ${today}.`);
    await processAndStore(enriched, preScored);
    // Prestige is resolved by the nightly pre-scored JSON (preScored path).
    // Local bulk HTML fetching removed — too slow for same-day papers and
    // unnecessary once the agent pipeline is running.

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

// Fetch today's paper count AND the authoritative set of paper IDs from the listing page.
// The listing page is the ground truth for which papers belong to today's announcement.
// Returns { count, ids } — ids is a Set of arxiv IDs (e.g. "2604.08504").
// Falls back to { count: FALLBACK_COUNT, ids: null } if the page is unavailable.
async function fetchTodayListing() {
  try {
    const resp = await fetchWithTimeout(LISTING_URL, 15000);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    // The listing page has three sections in order:
    //   New submissions (showing N of N entries)
    //   Cross-submissions (showing N of N entries)
    //   Replacement submissions (showing N of N entries)
    // We want New + Cross-submissions, not Replacements.
    const re = /showing\s+(?:first\s+)?\d+\s+of\s+(\d+)\s+entr/gi;
    const matches = [...html.matchAll(re)];
    let count;
    if (matches.length >= 2) {
      count = parseInt(matches[0][1], 10) + parseInt(matches[1][1], 10);
      console.log(`[arXiv] Listing: ${matches[0][1]} new + ${matches[1][1]} cross-listed = ${count} total.`);
    } else if (matches.length === 1) {
      count = parseInt(matches[0][1], 10);
      console.log(`[arXiv] Listing: ${count} papers (single section).`);
    } else {
      throw new Error('count not found in listing page');
    }

    // Extract the authoritative paper IDs from New + Cross-submissions sections.
    // The listing page has three <dl id='articles'> blocks in order:
    //   [1] New submissions  [2] Cross-submissions  [3] Replacement submissions
    // Split on that tag and take only sections 1 and 2 — skip Replacements entirely.
    // arXiv listing uses `href ="/abs/YYMM.NNNNN"` (note the space before =).
    const dlSections = html.split("<dl id='articles'>");
    const newAndCross = dlSections.slice(1, 3).join(' '); // sections 1 + 2 only
    const idMatches = [...newAndCross.matchAll(/href\s*="\/abs\/(\d{4}\.\d{4,6})(?:v\d+)?"/g)];
    const ids = new Set(idMatches.map(m => m[1]));
    console.log(`[arXiv] Listing IDs extracted: ${ids.size} (whitelist for today's announcement).`);

    return { count, ids };
  } catch (e) {
    console.warn(`[arXiv] Listing page failed (${e.message}), falling back to count=${FALLBACK_COUNT}, no ID whitelist.`);
    return { count: FALLBACK_COUNT, ids: null };
  }
}

async function fetchArxivBatch(count, ids) {
  // If we have the authoritative ID list from the listing page, fetch those exact
  // papers by id_list. This handles cross-listed papers that were submitted days
  // ago to other categories — they'd be missed by a submittedDate-sorted search.
  // Fall back to the search query if no IDs were extracted.
  if (ids?.size) {
    const idArray = [...ids];
    const CHUNK = 120; // arXiv API rejects very long id_list URLs; 120 IDs ≈ safe limit
    console.log(`[arXiv] Fetching ${idArray.length} papers by id_list in chunks of ${CHUNK}…`);
    const chunks = [];
    for (let i = 0; i < idArray.length; i += CHUNK) chunks.push(idArray.slice(i, i + CHUNK));
    const results = await Promise.all(chunks.map(async chunk => {
      const params = new URLSearchParams({ id_list: chunk.join(','), max_results: chunk.length });
      const resp = await fetchWithTimeout(`${API_BASE}?${params}`, REQUEST_TIMEOUT);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return parseAtomXML(await resp.text());
    }));
    const papers = results.flat();
    console.log(`[arXiv] cs.AI: ${papers.length} papers fetched by id_list (${chunks.length} chunks).`);
    return papers;
  }

  // Fallback: search query sorted by submittedDate (may miss older cross-listings).
  console.log(`[arXiv] Fetching ${count} cs.AI papers by search query (no ID list)…`);
  const params = new URLSearchParams({
    search_query: 'cat:cs.AI',
    start: 0,
    max_results: count,
    sortBy: 'submittedDate',
    sortOrder: 'descending'
  });
  const resp = await fetchWithTimeout(`${API_BASE}?${params}`, REQUEST_TIMEOUT);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const xml = await resp.text();
  const papers = parseAtomXML(xml);
  console.log(`[arXiv] cs.AI: ${papers.length} papers fetched.`);
  return papers;
}


// ═══════════════════════════════════════════════════════
// PRESTIGE — arXiv HTML affiliation scan
// ═══════════════════════════════════════════════════════

// Pre-scored JSON published daily by GitHub Actions — extension fetches this first.
// Format: { date, papers: { arxivId: { applied, prestige, cluster, format } } }
const SCORES_BASE_URL = 'https://raw.githubusercontent.com/eperopolis0/arxiv-browser/main/scores';

async function fetchPreScoredJSON(date) {
  try {
    const resp = await fetchWithTimeout(`${SCORES_BASE_URL}/${date}.json`, 10000);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data?.date === date && data?.papers) {
      console.log(`[arXiv] Pre-scored JSON loaded: ${Object.keys(data.papers).length} papers.`);
      return data.papers; // { arxivId: { applied, prestige, cluster, format } }
    }
    return null;
  } catch (e) {
    console.log(`[arXiv] No pre-scored JSON for ${date} (${e.message}) — will score locally.`);
    return null;
  }
}

// Tier 3 — Pure frontier AI labs only. These are orgs whose primary purpose is
// frontier AI research — a paper from here is almost always worth flagging.
// Goal: a handful per day at most.
const PRESTIGE_TIER3 = [
  'anthropic',
  'openai',
  'deepmind','google deepmind','google brain',
  'meta ai','fundamental ai research','fair ',  // FAIR = Meta's Fundamental AI Research lab
];

// Tier 2 — Elite research programs with real AI depth.
// Matched by institution name in affiliation text; NOT by email domain (too broad).
// Goal: scannable — maybe 10–30 papers/day.
const PRESTIGE_TIER2 = [
  // US universities (top CS with strong AI focus)
  'massachusetts institute of technology','mit csail',
  'stanford university','stanford ai lab',
  'carnegie mellon university',
  'university of california, berkeley','uc berkeley','berkeley artificial intelligence',
  'california institute of technology','caltech',
  'cornell university','cornell tech',
  'university of washington',
  'princeton university',
  'new york university','courant institute',
  // International universities with strong AI research
  'university of oxford',
  'university of cambridge',
  'eth zurich','eth zürich',
  'epfl','école polytechnique fédérale de lausanne',
  'university of toronto',
  'mila','université de montréal',
  'imperial college london',
  // Dedicated AI research arms of big tech (matched by specific name, not parent company)
  'google research',
  'microsoft research',
  'meta ai','fundamental ai research',
  'allen institute for ai','allen institute for artificial intelligence',
  'vector institute',
];

// Email domains for fetchHTMLPrestige scan.
// Tier 3: only orgs with dedicated frontier-AI email domains.
// Tier 2: top university domains only — no broad company domains.
const EMAIL_DOMAIN_TIER3 = [
  'anthropic.com','openai.com','deepmind.com','meta.com',
];
const EMAIL_DOMAIN_TIER2 = [
  'mit.edu','stanford.edu','cmu.edu','berkeley.edu',
  'cornell.edu','uw.edu','princeton.edu','nyu.edu','caltech.edu',
  'ox.ac.uk','cam.ac.uk','ethz.ch','epfl.ch',
  'utoronto.ca','mila.quebec',
  'ic.ac.uk',
];

// Extract the HTML between the opening of one div class and the opening of another.
// Used to get the authors section (ltx_authors → ltx_abstract) without depth-counting,
// which is fragile when nested divs are present or absent.
function extractBetweenDivs(html, startClass, endClass) {
  const startRe = new RegExp('<div[^>]*' + startClass + '[^>]*>', 'i');
  const endRe   = new RegExp('<div[^>]*' + endClass   + '[^>]*>', 'i');
  const startM  = startRe.exec(html);
  if (!startM) return null;
  const endM = endRe.exec(html.slice(startM.index));
  if (!endM) return null;
  return html.slice(startM.index, startM.index + endM.index);
}

// On-click prestige scan: fetch the first 128KB of the arxiv latexml HTML version.
// Scans only the region between ltx_authors and ltx_abstract — never the body.
// Handles both ltx_role_affiliation spans and bare text nodes (e.g. Anthropic papers).
// Returns 3, 2, 1 (confirmed), or null (no HTML version or no affiliation data found).
async function fetchHTMLPrestige(arxivId) {
  const url = `https://arxiv.org/html/${arxivId}`;
  let text;
  try {
    const resp = await fetchWithTimeout(url, 6000, {
      headers: { Range: 'bytes=0-131071' }
    });
    if (resp.status !== 200 && resp.status !== 206) return null;
    text = await resp.text();
  } catch (e) {
    console.warn(`[Prestige] Fetch failed for ${arxivId}: ${e.message}`);
    return null;
  }

  // Extract the authors section: from ltx_authors opening to ltx_abstract opening.
  // Scoping to this window avoids catching institution names or emails in the paper body.
  // Falls back to full text only if extraction fails (truncated HTML, unusual structure).
  // Scope everything to the authors block — never fall back to full page text.
  // Papers that merely *discuss* or *cite* frontier labs would get false tier-3 hits.
  const authorsBlock = extractBetweenDivs(text, 'ltx_authors', 'ltx_abstract');
  if (!authorsBlock) return null;

  let affiliationText = '';
  const affRe = /<span[^>]*ltx_role_affiliation[^>]*>([\s\S]*?)<\/span>/gi;
  let affM;
  while ((affM = affRe.exec(authorsBlock)) !== null) {
    affiliationText += ' ' + affM[1].replace(/<[^>]+>/g, ' ');
  }
  // Fallback: strip all tags from the authors section (handles bare text nodes
  // like Anthropic papers where the institution name isn't in a dedicated span).
  if (!affiliationText.trim()) {
    affiliationText = authorsBlock.replace(/<[^>]+>/g, ' ');
  }

  // Email scan scoped to authors section only.
  const emailText = (authorsBlock.match(/\b[\w.+%-]+@[\w-]+\.[\w.]+\b/gi) || []).join(' ');

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

// Fetch HTML prestige for all null-prestige papers in processedPapers.
// Uses a concurrent pool of 8 workers — keeps total time ~30-60s for ~500 papers
// vs ~300s for the old serial approach in newtab.js.
// Writes results back to processedPapers in storage when done.
async function fetchPrestigeForAll() {
  const { processedPapers = [] } = await getStorage(['processedPapers']);
  const queue = processedPapers.filter(p => p.prestige === null);
  if (!queue.length) { console.log('[arXiv] All papers already have prestige — skipping.'); return; }

  console.log(`[arXiv] Fetching prestige for ${queue.length} papers (8 concurrent)…`);
  let idx = 0, resolved = 0;

  async function worker() {
    while (idx < queue.length) {
      const p = queue[idx++];
      const tier = await fetchHTMLPrestige(p.id).catch(() => null);
      p.prestige = tier;  // null = unverified (HTML not available yet); tier 1/2/3 = confirmed
      if (tier !== null) resolved++;
    }
  }

  await Promise.all(Array.from({ length: 8 }, worker));

  // Write updated prestige values back into processedPapers
  const idToTier = new Map(queue.map(p => [p.id, p.prestige]));
  processedPapers.forEach(p => { if (idToTier.has(p.id)) p.prestige = idToTier.get(p.id); });
  await setStorage({ processedPapers });

  const t3 = processedPapers.filter(p => p.prestige === 3).length;
  const t2 = processedPapers.filter(p => p.prestige === 2).length;
  const tNull = processedPapers.filter(p => p.prestige === null).length;
  console.log(`[arXiv] Prestige done — ✦✦✦${t3} ✦✦${t2} ✦${processedPapers.length - t3 - t2 - tNull} unverified:${tNull}`);
  chrome.runtime.sendMessage({ action: 'dataUpdated' }).catch(() => {});
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
  const titleL = title.toLowerCase();
  const text = (title + ' ' + summary).toLowerCase();
  // Title-only for dataset/corpus — too common as passing mentions in abstracts.
  // "benchmark" fires anywhere; "we benchmark X" in abstract is usually still a benchmark paper.
  if (/\b(benchmark|leaderboard|evaluation suite)\b/.test(text)) return 'benchmark';
  if (/\b(dataset|corpus)\b/.test(titleL)) return 'benchmark';
  if (/\b(survey|overview|review|tutorial|comprehensive study|systematic review)\b/.test(text)) return 'survey';
  if (/\b(theorem|lemma|proof|regret bound|sample complexity|convergence rate|upper bound|lower bound|pac learning|information.theoretic|complexity analysis|formal(ly| proof)|provably)\b/.test(text)) return 'theory';
  if (/\b(position paper|we argue|we contend|we call for|we urge|manifesto|perspective|opinion)\b/.test(text)) return 'position';
  return 'empirical';
}


function scoreApplied(title, summary, cat, format) {
  const text = (title + ' ' + (summary || '')).toLowerCase();
  // Format prior: classifyFormat uses word-boundary regex — stronger signal than keyword counts
  const FORMAT_PRIOR = { theory:0.15, survey:0.28, empirical:0.32, benchmark:0.58, position:0.38 };
  const base = FORMAT_PRIOR[format] ?? 0.32;
  // Category nudge: some fields are structurally applied/mechanistic regardless of abstract text
  const CAT_ADJ = { 'cs.RO':0.12, 'cs.HC':0.10, 'cs.IR':0.06, 'cs.CV':0.04, 'cs.LG':-0.04 };
  const catAdj = CAT_ADJ[cat] ?? 0;
  const aTerms = [
    // deployment & real-world use
    'deploy','real-world','production','commercial',
    'on-device','edge','in the wild','open-source','open source','released','api',
    // systems & tools
    'system','framework','tool','pipeline','end-to-end',
    // task-solving & benchmarks
    'dataset','state-of-the-art','outperforms','downstream',
    'fine-tuning','fine-tune','instruction','agent','autonomous','robot',
    // human-facing
    'user study','human evaluation','user interface','clinical','medical','healthcare',
  ];
  const mTerms = [
    // mathematical theory
    'theorem','lemma','proof','regret','sample complexity','convergence',
    'upper bound','lower bound','pac learning','formal','asymptotic',
    'minimax','information-theoretic','information theoretic',
    // mechanistic understanding
    'mechanistic','interpretability','probing','representations','circuits',
    'activation','internals','features','attention heads',
    // analytical intent
    'we analyze','we study','we investigate','we show that',
    'understanding','insight','why does','how does','what does',
    'ablation','empirical analysis','scaling law','scaling laws',
  ];
  const a = aTerms.filter(t => text.includes(t)).length;
  const m = mTerms.filter(t => text.includes(t)).length;
  return Math.min(1, Math.max(0, base + catAdj + a * 0.10 - m * 0.12));
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


const CLUSTER_MAP = [
  { name:'Agents & Planning',        keys:['agent','agentic','multi-agent','autonomous agent','tool use','tool call','planning','workflow','orchestrat','chain-of-thought','reasoning trace','decision mak'] },
  { name:'Safety & Alignment',       keys:['safety','alignment','harmful','jailbreak','red team','toxicity','bias','fairness','watermark','adversarial','privacy','decepti','misinform','hallucin','trustworth','robust'] },
  { name:'Image & Video Generation', keys:['image generation','video generation','diffusion model','text-to-image','text-to-video','inpaint','outpaint','image synthesis','video synthesis','gan','generative adversarial','stable diffusion','denoising'] },
  { name:'Visual Understanding',     keys:['visual question','vqa','image caption','visual grounding','scene understand','multimodal','vision-language','vlm','visual reasoning','image-text','chart understand','document understand'] },
  { name:'Vision: Detection',        keys:['object detect','instance segment','semantic segment','bounding box','yolo','detr','panoptic','depth estimat','pose estimat','3d reconstruction','point cloud','lidar','nerf'] },
  { name:'Reinforcement Learning',   keys:['reinforcement learn','reward model','policy gradient','value function','q-learning','ppo','actor-critic','offline rl','exploration','bandit','markov','mcts','game play'] },
  { name:'Robotics & Embodied',      keys:['robot','manipulation','gripper','locomotion','embodied','sim-to-real','dexterous','imitation learn','motor control','navigation','autonomous driv'] },
  { name:'Audio & Speech',           keys:['speech recognit','speech synthesis','speech emotion','emotion recognit','text-to-speech','speaker verif','speaker diariz','audio classif','audio-language','audio model','sound event','music generat','acoustic model','asr','tts','voice conver','codec','prosody','audio','music','spoken language','speech model','audio generation','speech processing'] },
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


async function processAndStore(rawPapers, preScored = null) {
  if (!rawPapers?.length) {
    console.warn('[arXiv] processAndStore called with 0 papers — skipping.');
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[arXiv] Processing ${rawPapers.length} papers…`);

  // Carry forward prestige scores from any previous processedPapers — avoids
  // re-fetching HTML for papers we already verified on a manual refresh.
  const { processedPapers: prev = [] } = await getStorage(['processedPapers']);
  const prevPrestige = new Map(prev.map(p => [p.id, p.prestige]));

  const papers = rawPapers.map(p => {
    const title   = stripLatex(p.title   || '');
    const summary = stripLatex(p.summary || '');
    const cat = (p.categories || []).find(c => c.startsWith('cs.')) || p.categories?.[0] || 'cs.AI';
    const scored  = preScored?.[p.arxivId];
    const cluster = scored?.cluster || classifyPaper(title, summary, cat);
    const prestige = scored?.prestige ?? prevPrestige.get(p.arxivId) ?? p.prestige ?? null;
    const format  = scored?.format || classifyFormat(title, summary);
    return {
      id:        p.arxivId,
      title,
      gist:      summary.slice(0, 200).replace(/\s+/g,' ').toLowerCase(),
      cat,
      format,
      applied:   scored?.applied ?? scoreApplied(title, summary, cat, format),
      relevance: scoreRelevance(cat, title, summary),
      prestige,
      starred:   false,
      clusters:  [cluster],
      _absLink:   p.absLink  || `https://arxiv.org/abs/${p.arxivId}`,
      _pdfLink:   p.pdfLink  || `https://arxiv.org/pdf/${p.arxivId}`,
      _authors:   (p.authors || []).slice(0,3).join(', '),
      _summary:   summary,
      _published: (p.published || '').slice(0, 10),
      _updated:   (p.updated   || p.published || '').slice(0, 10),
    };
  });

  const preScoreCount = papers.filter(p => preScored?.[p.id]).length;
  console.log(preScoreCount === papers.length
    ? `[arXiv] All ${papers.length} papers pre-scored — rendering instantly.`
    : `[arXiv] ${preScoreCount}/${papers.length} pre-scored — rendering with keyword fallback for the rest.`
  );
  await setStorage({ processedPapers: papers });
  chrome.runtime.sendMessage({ action: 'dataUpdated' }).catch(() => {});

  // Compute per-cat, per-format, and per-cluster mean applied scores for today
  const CAT_KEYS = ['cs.LG','cs.CL','cs.IR','cs.AI','cs.CV','cs.HC','cs.CR','cs.RO'];
  const FMT_KEYS = ['empirical','benchmark','survey','theory','position'];
  const catScores = {}, fmtScores = {}, clusterScores = {};
  CAT_KEYS.forEach(cat => {
    const sub = papers.filter(p => p.cat === cat);
    catScores[cat] = sub.length ? sub.reduce((s,p) => s + p.applied, 0) / sub.length : null;
  });
  FMT_KEYS.forEach(fmt => {
    const sub = papers.filter(p => p.format === fmt);
    fmtScores[fmt] = sub.length ? sub.reduce((s,p) => s + p.applied, 0) / sub.length : null;
  });
  const clusterNames = [...new Set(papers.map(p => p.clusters[0]).filter(Boolean))];
  clusterNames.forEach(name => {
    const sub = papers.filter(p => p.clusters[0] === name);
    clusterScores[name] = sub.length ? sub.reduce((s,p) => s + p.applied, 0) / sub.length : null;
  });

  // Append to rolling 7-day history (dedupe today, trim to last 7)
  const { appliedHistory: prevHistory = [] } = await getStorage(['appliedHistory']);
  const freshHistory = prevHistory.filter(e => e.date !== today);
  freshHistory.push({ date: today, cats: catScores, formats: fmtScores, clusters: clusterScores });
  const appliedHistory = freshHistory.sort((a,b) => a.date.localeCompare(b.date)).slice(-7);

  const clusterCounts = {};
  papers.forEach(p => { const c = p.clusters[0]; clusterCounts[c] = (clusterCounts[c]||0)+1; });
  const t3 = papers.filter(p => p.prestige === 3).length;
  const t2 = papers.filter(p => p.prestige === 2).length;
  await setStorage({ processedPapers: papers, appliedHistory });
  console.log(`[arXiv] Stored ${papers.length} papers. Prestige: ★★★${t3} ★★${t2} ★${papers.length-t3-t2}. Clusters: ${Object.entries(clusterCounts).map(([k,v])=>`${k}(${v})`).join(', ')}`);

  await updateScoreStats(papers);
}

// ── Score Stats (Welford running aggregates) ──────────────
// Accumulates per-format, per-cat, per-cluster mean + variance of applied scores
// across all time. Used later to compute discriminability weights that replace
// the hardcoded FORMAT_PRIOR / CAT_ADJ tables.
//
// Uses Welford's online algorithm (https://en.wikipedia.org/wiki/Algorithms_for_calculating_variance#Welford%27s_online_algorithm)
// so we never need to re-read historical paper scores — each batch is a single O(n) pass.
//
// Guard: keyed by date so re-processing the same day's papers (e.g. on browser restart)
// doesn't double-count.

async function updateScoreStats(papers) {
  const today = new Date().toISOString().slice(0, 10);
  const { scoreStats: prev = null, scoreStatsLastDate = null } = await getStorage(['scoreStats', 'scoreStatsLastDate']);

  if (scoreStatsLastDate === today) {
    console.log('[arXiv] scoreStats already updated for today — skipping.');
    return;
  }

  const stats = prev || {
    v: 1,
    global:  { n: 0, mean: 0, m2: 0 },
    format:  {},
    cat:     {},
    cluster: {}
  };

  function welford(s, x) {
    s.n++;
    const d1 = x - s.mean;
    s.mean += d1 / s.n;
    s.m2   += d1 * (x - s.mean);  // uses updated mean — keeps m2 numerically stable
  }

  function slot(obj, key) {
    if (!obj[key]) obj[key] = { n: 0, mean: 0, m2: 0 };
    return obj[key];
  }

  for (const p of papers) {
    const x = p.applied;
    welford(stats.global, x);
    welford(slot(stats.format,  p.format),       x);
    welford(slot(stats.cat,     p.cat),           x);
    const cl = p.clusters?.[0];
    if (cl) welford(slot(stats.cluster, cl),      x);
  }

  stats.updatedAt = today;
  await setStorage({ scoreStats: stats, scoreStatsLastDate: today });

  // Log top clusters by mean applied score (min n=10 to filter noise)
  const topClusters = Object.entries(stats.cluster)
    .filter(([, g]) => g.n >= 10)
    .sort((a, b) => b[1].mean - a[1].mean)
    .slice(0, 6)
    .map(([k, g]) => `${k}(μ=${g.mean.toFixed(2)},n=${g.n})`)
    .join(', ');
  console.log(`[arXiv] scoreStats updated — global: μ=${stats.global.mean.toFixed(3)}, n=${stats.global.n} | clusters: ${topClusters}`);
}
