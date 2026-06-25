#!/usr/bin/env node
// score-today.mjs — Daily arXiv cs.AI scorer
// Fetches today's papers, scores them with Haiku, extracts prestige, classifies clusters.
// Writes scores/YYYY-MM-DD.json for the extension to consume.
//
// Usage: ANTHROPIC_API_KEY=sk-ant-... node scorer/score-today.mjs

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

const OAI_BASE    = 'https://oaipmh.arxiv.org/oai';
const LISTING_URL = 'https://arxiv.org/list/cs.AI/new';
const OAI_SET     = 'cs:cs:AI';

// arXiv's edge layer rejects cloud-IP requests carrying undici's default
// `User-Agent: node` with an instant HTTP 406. A descriptive UA (which arXiv's
// API guidelines ask for anyway) gets the GitHub Actions runner through.
const USER_AGENT = 'arxiv-browser/1.0 (+https://github.com/eperopolis0/arxiv-browser)';

// ── Fetch helpers ──────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, ms = 30000, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': USER_AGENT, ...opts.headers },
      signal: ctrl.signal,
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── arXiv listing — extract today's canonical paper IDs ───────────────────────

async function fetchTodayListing() {
  console.log('[listing] Fetching cs.AI/new…');
  const resp = await fetchWithTimeout(LISTING_URL, 20000);
  if (!resp.ok) throw new Error(`Listing HTTP ${resp.status}`);
  const html = await resp.text();

  const re = /showing\s+(?:first\s+)?\d+\s+of\s+(\d+)\s+entr/gi;
  const matches = [...html.matchAll(re)];
  let count = 0;
  if (matches.length >= 2) {
    count = parseInt(matches[0][1], 10) + parseInt(matches[1][1], 10);
    console.log(`[listing] ${matches[0][1]} new + ${matches[1][1]} cross = ${count} total`);
  } else if (matches.length === 1) {
    count = parseInt(matches[0][1], 10);
    console.log(`[listing] ${count} papers`);
  } else {
    throw new Error('Could not find paper count in listing page');
  }

  // Split on <dl id='articles'> — take sections 1+2 (New + Cross), skip Replacements.
  const dlSections = html.split("<dl id='articles'>");
  const newAndCross = dlSections.slice(1, 3).join(' ');
  const idMatches = [...newAndCross.matchAll(/href\s*="\/abs\/(\d{4}\.\d{4,6})(?:v\d+)?"/g)];
  const ids = new Set(idMatches.map(m => m[1]));

  // Diff against /recent to catch papers arXiv counts as new but puts in replacements.
  // Fetch show=(count+50) so we cover the full day even on busy Tuesdays.
  // Only add extras if the diff is ≤ 5 — larger diffs mean a bulk replacement day.
  try {
    const recentResp = await fetchWithTimeout(
      `https://arxiv.org/list/cs.AI/recent?skip=0&show=${count + 50}`, 20000
    );
    if (recentResp.ok) {
      const recentHtml = await recentResp.text();
      // /recent groups by date under <h3> headers — take only the first section (today).
      const parts = recentHtml.split(/<h3[\s>]/);
      const todaySection = parts.length >= 2 ? parts[0] + parts[1] : recentHtml;
      const recentIds = new Set(
        [...todaySection.matchAll(/href\s*="\/abs\/(\d{4}\.\d{4,6})(?:v\d+)?"/g)].map(m => m[1])
      );
      const extras = [...recentIds].filter(id => !ids.has(id));
      if (extras.length > 0 && extras.length <= 5) {
        console.log(`[listing] /recent has ${extras.length} extra(s) vs /new — adding: ${extras.join(', ')}`);
        extras.forEach(id => ids.add(id));
      } else if (extras.length > 5) {
        console.log(`[listing] /recent has ${extras.length} extras vs /new — too many, skipping (bulk replacement day).`);
      }
    }
  } catch (e) {
    console.warn(`[listing] /recent diff failed: ${e.message} — continuing with /new IDs only.`);
  }

  const idList = [...ids];
  console.log(`[listing] ${idList.length} IDs extracted`);
  return { count, ids: idList };
}

// ── arXiv OAI-PMH — fetch full metadata for today's announced papers ──────────
//
// We use OAI-PMH (the documented bulk-metadata path) rather than the interactive
// API. Two prior failures came from arXiv's API edge layer reacting badly to
// GHA cloud-IP traffic: 406 (User-Agent blocked) and sustained 429 (rate-limit
// window ≥92 min). OAI-PMH lives on a different subdomain (oaipmh.arxiv.org)
// with its own infrastructure and explicit bulk-use blessing.
//
// We query a multi-day date WINDOW (not just today) because OAI's <datestamp>
// is the metadata-modification day, which lags the announcement — see the
// OAI_LOOKBACK_DAYS note below. The window returns a SUPERSET; we intersect with
// the listing-page IDs (the authoritative "announced today" set) to get exactly
// what the user expects, and GetRecord any stragglers the window still misses.

function xmlText(m) {
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&'); // &amp; last so we don't double-decode
}

function parseOAIRecords(xml) {
  const records = xml.split('<record>').slice(1);
  const papers = [];
  for (const r of records) {
    const m = /<arXiv[^>]*>([\s\S]*?)<\/arXiv>/.exec(r);
    if (!m) continue;
    const inner = m[1];
    const arxivId = (/<id>\s*([^<]+?)\s*<\/id>/.exec(inner) || [])[1] || '';
    const title   = decodeEntities(xmlText(/<title>([\s\S]*?)<\/title>/.exec(inner)));
    const summary = decodeEntities(xmlText(/<abstract>([\s\S]*?)<\/abstract>/.exec(inner)));
    const created = (/<created>\s*([^<]+?)\s*<\/created>/.exec(inner) || [])[1] || '';
    const updated = (/<updated>\s*([^<]+?)\s*<\/updated>/.exec(inner) || [])[1] || created;
    const catsRaw = (/<categories>\s*([^<]+?)\s*<\/categories>/.exec(inner) || [])[1] || '';
    const categories = catsRaw.split(/\s+/).filter(Boolean);
    const cat = categories.find(c => c.startsWith('cs.')) || categories[0] || 'cs.AI';
    const authorMatches = [...inner.matchAll(
      /<author>[\s\S]*?<keyname>([^<]+)<\/keyname>(?:[\s\S]*?<forenames>([^<]+)<\/forenames>)?[\s\S]*?<\/author>/g
    )];
    const authors = authorMatches.map(am => {
      const last = am[1].trim();
      const first = (am[2] || '').trim();
      return first ? `${first} ${last}` : last;
    });
    if (arxivId && title) {
      papers.push({ arxivId, title, summary, published: created, updated, authors, categories, cat });
    }
  }
  return papers;
}

// OAI-PMH bulk pages flake transiently — a single 60s timeout or 5xx used to
// kill the entire daily run, leaving no scores/<date>.json until the morning
// safety-net cron hours later. Retry a page a few times with backoff before
// giving up; honor Retry-After on 503/429. Returns the page XML.
async function fetchOAIPage(url, attempts = 4) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, 60000);
      if (resp.status === 503 || resp.status === 429) {
        const ra = parseInt(resp.headers.get('retry-after') || '', 10);
        const waitMs = Number.isFinite(ra) ? ra * 1000 : attempt * 5000;
        lastErr = new Error(`OAI-PMH HTTP ${resp.status}`);
        console.warn(`[oai] HTTP ${resp.status} — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${attempts})`);
        if (attempt < attempts) await sleep(waitMs);
        continue;
      }
      if (!resp.ok) throw new Error(`OAI-PMH HTTP ${resp.status}`);
      return await resp.text();
    } catch (e) {
      lastErr = e;
      if (attempt === attempts) break;
      const waitMs = attempt * 5000;
      console.warn(`[oai] page fetch failed (${e.message}) — retrying in ${waitMs / 1000}s (attempt ${attempt}/${attempts})`);
      await sleep(waitMs);
    }
  }
  throw lastErr || new Error('OAI-PMH page fetch failed');
}

// Number of days to look back in the OAI-PMH date window. The listing page is
// authoritative for *which* papers were announced today; OAI's <datestamp> only
// tells us which day-bucket it filed the metadata under — and those disagree.
// On Mondays (and after any weekend/holiday gap) arXiv announces papers whose
// OAI datestamp is the previous business day, so from=today&until=today finds
// nothing (observed 2026-06-22: 220 announced papers all datestamped 06-19,
// three days earlier). A multi-day window catches them; intersecting with the
// listing IDs keeps the result exact, so widening the window can only add
// candidates to match against, never wrong papers.
const OAI_LOOKBACK_DAYS = 5;
// Cap on the per-ID GetRecord fallback. After a 5-day bulk window, only a small
// tail should ever be missing; a large miss count means OAI is systemically
// behind and per-ID requests won't rescue it (just slow the run), so we stop.
const GETRECORD_FALLBACK_CAP = 50;

// Fetch one record by its canonical arXiv ID via OAI-PMH GetRecord. Used as a
// fallback for listing IDs the bulk windowed ListRecords didn't return — the
// single-record path stayed healthy even during the June bulk-endpoint outages.
async function fetchRecordById(id) {
  const url = `${OAI_BASE}?verb=GetRecord&metadataPrefix=arXiv&identifier=oai:arXiv.org:${id}`;
  const xml = await fetchOAIPage(url);
  const recs = parseOAIRecords(xml);
  return recs.find(r => r.arxivId === id) || recs[0] || null;
}

async function fetchPapers(ids) {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - OAI_LOOKBACK_DAYS * 86400000)
    .toISOString().slice(0, 10);
  const idSet = new Set(ids);
  const matched = new Map();
  let token = null;
  let page = 0;

  console.log(`[oai] Window from=${from} until=${today} (lookback ${OAI_LOOKBACK_DAYS}d)`);
  do {
    page++;
    const url = token
      ? `${OAI_BASE}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`
      : `${OAI_BASE}?verb=ListRecords&metadataPrefix=arXiv&set=${OAI_SET}&from=${from}&until=${today}`;
    console.log(`[oai] Fetching page ${page}…`);
    const xml = await fetchOAIPage(url);
    const records = parseOAIRecords(xml);
    let pageMatched = 0;
    for (const r of records) {
      if (idSet.has(r.arxivId) && !matched.has(r.arxivId)) {
        matched.set(r.arxivId, r);
        pageMatched++;
      }
    }
    console.log(`[oai] Page ${page}: ${records.length} records, ${pageMatched} matched listing IDs (cumulative ${matched.size}/${ids.length})`);
    const tokenMatch = /<resumptionToken[^>]*>([^<]*)<\/resumptionToken>/.exec(xml);
    token = tokenMatch && tokenMatch[1].trim() ? tokenMatch[1].trim() : null;
    if (token) await sleep(3000); // arXiv guidance: stay under 1 req per 3s on OAI-PMH
  } while (token);

  // Per-ID GetRecord fallback for any announced papers the bulk window missed
  // (datestamp older than the window, or not yet in the bulk feed).
  let missing = ids.filter(id => !matched.has(id));
  if (missing.length) {
    const toFetch = missing.slice(0, GETRECORD_FALLBACK_CAP);
    if (missing.length > GETRECORD_FALLBACK_CAP) {
      console.warn(`[oai] ${missing.length} IDs missing after bulk window — fetching first ${GETRECORD_FALLBACK_CAP} via GetRecord (the rest suggest OAI is systemically behind).`);
    } else {
      console.log(`[oai] ${missing.length} ID(s) missing after bulk window — fetching via GetRecord…`);
    }
    let got = 0;
    for (const id of toFetch) {
      try {
        const r = await fetchRecordById(id);
        if (r && r.arxivId && r.title) { matched.set(r.arxivId, r); got++; }
      } catch (e) {
        console.warn(`[oai] GetRecord ${id} failed: ${e.message}`);
      }
      await sleep(1000); // single-record requests are cheap; stay polite
    }
    console.log(`[oai] GetRecord fallback recovered ${got}/${toFetch.length}`);
  }

  const papers = [...matched.values()];
  missing = ids.filter(id => !matched.has(id));
  if (missing.length) {
    console.warn(`[oai] ${missing.length} listing ID(s) still unresolved: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
  }
  return papers;
}

// ── Format + cluster classification (deterministic, no API needed) ─────────────

function classifyFormat(title, summary) {
  const titleL = title.toLowerCase();
  const text = (title + ' ' + summary).toLowerCase();
  if (/\b(benchmark|leaderboard|evaluation suite)\b/.test(text)) return 'benchmark';
  if (/\b(dataset|corpus)\b/.test(titleL)) return 'benchmark';
  if (/\b(survey|overview|review|tutorial|comprehensive study|systematic review)\b/.test(text)) return 'survey';
  if (/\b(theorem|lemma|proof|regret bound|sample complexity|convergence rate|upper bound|lower bound|pac learning|information.theoretic|complexity analysis|formal(ly| proof)|provably)\b/.test(text)) return 'theory';
  if (/\b(position paper|we argue|we contend|we call for|we urge|manifesto|perspective|opinion)\b/.test(text)) return 'position';
  return 'empirical';
}

const CLUSTER_MAP = [
  { name:'Agents & Planning',        keys:['agent','agentic','multi-agent','autonomous agent','tool use','tool call','planning','workflow','orchestrat','chain-of-thought','reasoning trace','decision mak'] },
  { name:'Safety & Alignment',       keys:['safety','alignment','harmful','jailbreak','red team','toxicity','bias','fairness','watermark','adversarial','privacy','decepti','misinform','hallucin','trustworth','robust'] },
  { name:'Image & Video Generation', keys:['image generation','video generation','diffusion model','text-to-image','text-to-video','inpaint','outpaint','image synthesis','video synthesis','gan','generative adversarial','stable diffusion','denoising'] },
  { name:'Visual Understanding',     keys:['visual question','vqa','image caption','visual grounding','scene understand','multimodal','vision-language','vlm','visual reasoning','image-text','chart understand','document understand'] },
  { name:'Vision: Detection',        keys:['object detect','instance segment','semantic segment','bounding box','yolo','detr','panoptic','depth estimat','pose estimat','3d reconstruction','point cloud','lidar','nerf'] },
  { name:'Reinforcement Learning',   keys:['reinforcement learn','reward model','policy gradient','value function','q-learning','ppo','actor-critic','offline rl','exploration','bandit','markov','mcts','game play'] },
  { name:'Robotics & Embodied',      keys:['robot','manipulation','gripper','locomotion','embodied','sim-to-real','dexterous','imitation learn','motor control','navigation','autonomous driv'] },
  { name:'Audio & Speech',           keys:['speech recognit','speech synthesis','speech emotion','emotion recognit','text-to-speech','speaker verif','speaker diariz','audio classif','audio-language','audio model','sound event','music generat','acoustic model','asr','tts','voice conver','codec','prosody','audio','music'] },
  { name:'Time Series & Signals',    keys:['time series','forecasting','temporal','anomaly detect','sensor','signal process','streaming','event stream','sequential data'] },
  { name:'Language & Translation',   keys:['machine translat','multilingual','low-resource','cross-lingual','nmt','tokeniz','morpholog','dialect','language transfer','bilingual'] },
  { name:'Efficiency & Compression', keys:['quantiz','pruning','distillation','compression','efficient','lightweight','mobile','edge deploy','inference speed','throughput','latency','hardware','sparsity'] },
  { name:'Fine-tuning & Adaptation', keys:['fine-tun','finetun','lora','peft','prompt tuning','adapter','instruction tuning','sft','rlhf','merging','few-shot','zero-shot adaptation','parameter-efficient'] },
  { name:'Retrieval & Knowledge',    keys:['retrieval augment','rag','knowledge graph','information retrieval','entity','relation extract','knowledge base','dense retrieval','rerank','index'] },
  { name:'Foundation Models',        keys:['pretrain','foundation model','scaling law','large language model','llm','gpt','bert','llama','transformer architecture','attention mechanism','self-supervised','contrastive learn'] },
];

function classifyCluster(title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  let best = null, bestScore = 0;
  for (const { name, keys } of CLUSTER_MAP) {
    const score = keys.filter(k => text.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = name; }
  }
  return best || 'General ML';
}

// ── Keyword-based applied score fallback ───────────────────────────────────────

function scoreAppliedKeyword(title, summary) {
  const text = (title + ' ' + (summary || '')).toLowerCase();
  const aTerms = ['deploy','real-world','production','industry','practical','commercial','on-device','edge','in the wild','open-source','open source','released','api','system','framework','tool','pipeline','end-to-end','benchmark','dataset','state-of-the-art','outperforms','downstream','fine-tuning','fine-tune','instruction','agent','autonomous','robot','user study','human evaluation','user interface','clinical','medical','healthcare'];
  const mTerms = ['theorem','lemma','proof','regret','sample complexity','convergence','upper bound','lower bound','pac learning','formal','asymptotic','minimax','information-theoretic','mechanistic','interpretability','probing','representations','circuits','activation','internals','features','attention heads','we analyze','we study','we investigate','we show that','we demonstrate that','understanding','insight','why does','how does','what does','ablation','empirical analysis','scaling law','scaling laws'];
  const a = aTerms.filter(t => text.includes(t)).length;
  const m = mTerms.filter(t => text.includes(t)).length;
  return Math.min(1, Math.max(0, 0.45 + a * 0.10 - m * 0.12));
}

// ── Haiku scoring ──────────────────────────────────────────────────────────────

function contributionSentence(summary) {
  const s = summary || '';
  const m = s.match(/(?:we\s+(?:introduce|propose|present|develop|describe|build|design|release|train|study|show|demonstrate|find|investigate|analyze)[^.!?]*[.!?])/i);
  return m ? m[0].trim() : s.slice(0, 120);
}

async function scoreChunkWithHaiku(papers) {
  const lines = papers.map((p, i) =>
    `${i+1}. "${p.title}" — ${contributionSentence(p.summary)}`
  ).join('\n');
  const prompt = `Classify each research paper on a scale from 0.0 to 1.0:
0.0 = Mechanism: analyzes, explains, or theorizes about how something works (interpretability, scaling laws, proofs, empirical analysis)
1.0 = Application: primarily builds or deploys something for real-world use (systems, robots, clinical tools, released software)

Papers:
${lines}

Output ONLY a JSON array of ${papers.length} floats in order. No explanation. Example: [0.3,0.8,0.1]`;

  const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', 60000, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Haiku HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  const text = data.content?.[0]?.text || '';
  const m = text.match(/\[[\d.,\s]+\]/);
  if (!m) throw new Error(`Haiku parse failed: ${text.slice(0, 100)}`);
  const scores = JSON.parse(m[0]);
  if (!Array.isArray(scores) || scores.length !== papers.length) throw new Error('Score count mismatch');
  return scores;
}

async function scoreAllWithHaiku(papers) {
  const CHUNK = 25;
  const scores = new Array(papers.length);
  for (let i = 0; i < papers.length; i += CHUNK) {
    const chunk = papers.slice(i, i + CHUNK);
    const label = `${i+1}–${Math.min(i+CHUNK, papers.length)}/${papers.length}`;
    try {
      console.log(`[haiku] Scoring papers ${label}…`);
      const chunkScores = await scoreChunkWithHaiku(chunk);
      chunkScores.forEach((s, j) => { scores[i + j] = s; });
    } catch (e) {
      console.warn(`[haiku] Chunk ${label} failed (${e.message}), using keyword fallback`);
      chunk.forEach((p, j) => { scores[i + j] = scoreAppliedKeyword(p.title, p.summary); });
    }
    if (i + CHUNK < papers.length) await sleep(1000);
  }
  return scores;
}

// ── Prestige — HTML affiliation scan ──────────────────────────────────────────

const PRESTIGE_TIER3 = [
  'anthropic','openai','deepmind','google deepmind','google brain',
  'meta ai','fundamental ai research',
];
const PRESTIGE_TIER2 = [
  'massachusetts institute of technology','mit csail',
  'stanford university','stanford ai lab',
  'carnegie mellon university',
  'university of california, berkeley','uc berkeley','berkeley artificial intelligence',
  'california institute of technology','caltech',
  'cornell university','cornell tech',
  'university of washington',
  'princeton university',
  'new york university','courant institute',
  'university of oxford','university of cambridge',
  'eth zurich','eth zürich',
  'epfl','école polytechnique fédérale de lausanne',
  'university of toronto','mila','université de montréal',
  'imperial college london',
  'google research','microsoft research',
  'allen institute for ai','allen institute for artificial intelligence',
  'vector institute',
];
const EMAIL_DOMAIN_TIER3 = ['anthropic.com','openai.com','deepmind.com','meta.com'];
const EMAIL_DOMAIN_TIER2 = ['mit.edu','stanford.edu','cmu.edu','berkeley.edu','cornell.edu','uw.edu','princeton.edu','nyu.edu','caltech.edu','ox.ac.uk','cam.ac.uk','ethz.ch','epfl.ch','utoronto.ca','mila.quebec','ic.ac.uk'];

function scoreTierFromText(text) {
  const t = text.toLowerCase();
  for (const kw of PRESTIGE_TIER3) { if (t.includes(kw)) return 3; }
  for (const d of EMAIL_DOMAIN_TIER3) { if (t.includes('@' + d)) return 3; }
  for (const kw of PRESTIGE_TIER2) { if (t.includes(kw)) return 2; }
  for (const d of EMAIL_DOMAIN_TIER2) { if (t.includes('@' + d)) return 2; }
  return null; // affiliation found but unrecognized — leave as unverified
}

function extractBetweenDivs(html, startClass, endClass) {
  const startRe = new RegExp('<div[^>]*' + startClass + '[^>]*>', 'i');
  const endRe   = new RegExp('<div[^>]*' + endClass   + '[^>]*>', 'i');
  const startM  = startRe.exec(html);
  if (!startM) return null;
  const endM = endRe.exec(html.slice(startM.index));
  if (!endM) return null;
  return html.slice(startM.index, startM.index + endM.index);
}

async function fetchHTMLPrestige(arxivId) {
  try {
    const resp = await fetchWithTimeout(`https://arxiv.org/html/${arxivId}`, 12000, {
      headers: { Range: 'bytes=0-131071' },
    });
    if (resp.status !== 200 && resp.status !== 206) return null;
    const text = await resp.text();
    const authorsBlock = extractBetweenDivs(text, 'ltx_authors', 'ltx_abstract');
    if (!authorsBlock) return null; // non-standard HTML structure — don't scan full page
    const scanSource = authorsBlock;
    let affiliationText = '';
    const affRe = /<span[^>]*ltx_role_affiliation[^>]*>([\s\S]*?)<\/span>/gi;
    let affM;
    while ((affM = affRe.exec(scanSource)) !== null) {
      affiliationText += ' ' + affM[1].replace(/<[^>]+>/g, ' ');
    }
    const authorsSrc = authorsBlock;
    const emailText = (authorsSrc.match(/\b[\w.+%-]+@[\w-]+\.[\w.]+\b/gi) || []).join(' ');
    if (!affiliationText.trim() && !emailText) return null;
    return scoreTierFromText(affiliationText + ' ' + emailText);
  } catch (e) {
    return null;
  }
}

async function fetchPrestigeForAll(papers) {
  console.log(`[html] Checking ${papers.length} papers for affiliations…`);
  const prestigeMap = new Map();
  const CONCURRENCY = 10;
  for (let i = 0; i < papers.length; i += CONCURRENCY) {
    const chunk = papers.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async p => {
      const tier = await fetchHTMLPrestige(p.arxivId);
      if (tier !== null) prestigeMap.set(p.arxivId, tier);
    }));
    if (i + CONCURRENCY < papers.length) await sleep(1500);
    if ((i / CONCURRENCY) % 10 === 0) console.log(`[html] ${Math.min(i + CONCURRENCY, papers.length)}/${papers.length} done`);
  }
  const matched = prestigeMap.size;
  console.log(`[html] ${matched}/${papers.length} papers got prestige`);
  return prestigeMap;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
  const outPath = join(ROOT, 'scores', `${today}.json`);

  console.log(`\n=== arXiv scorer — ${today} ===\n`);

  // 1. Get today's paper IDs from listing page. Fetched BEFORE the idempotency
  //    check below so we can compare any existing file against the live listing
  //    (the listing GET is cheap; expensive OAI/Haiku work still only runs on a
  //    real regeneration).
  const { ids } = await fetchTodayListing();
  if (!ids.length) { console.error('No IDs found — exiting'); process.exit(1); }

  // Readiness floor: a real cs.AI weekday announces 150+ papers. A count this low
  // means we caught arXiv mid-publish — only a cross-list stub is up, with no
  // "New submissions" section yet. Don't persist a partial day; exit so a later
  // safety-net cron retries once publishing completes. (2026-06-25: a 04:38 UTC
  // run saw 2 IDs and wrote a 2-paper file that then blocked every safety net.)
  const MIN_PLAUSIBLE_DAY = 20;
  if (ids.length < MIN_PLAUSIBLE_DAY) {
    console.error(`[not-ready] listing has only ${ids.length} ID(s) (< ${MIN_PLAUSIBLE_DAY}) — arXiv likely mid-publish; exiting so a later run retries.`);
    process.exit(1);
  }

  // Idempotency + self-heal: workflow does a fresh checkout, so file-on-disk =
  // committed by a prior run today. Normally that makes the safety-net crons a
  // near-free no-op. But if the existing file is far smaller than the current
  // listing (a degenerate partial-day file from a mid-publish run), regenerate
  // instead of skipping — this is what lets the safety nets self-heal.
  if (existsSync(outPath)) {
    let existingCount = 0;
    try { existingCount = Object.keys(JSON.parse(readFileSync(outPath, 'utf8')).papers || {}).length; } catch {}
    if (existingCount >= ids.length * 0.5) {
      console.log(`[skip] scores/${today}.json already has ${existingCount} papers (listing: ${ids.length}) — exiting cleanly.`);
      return;
    }
    console.warn(`[regen] existing scores/${today}.json has only ${existingCount} papers but listing now shows ${ids.length} — regenerating.`);
  }

  // 2. Fetch metadata
  const papers = await fetchPapers(ids);
  if (!papers.length) { console.error('No papers fetched — exiting'); process.exit(1); }

  // 3. Score applied dimension with Haiku
  const appliedScores = await scoreAllWithHaiku(papers);

  // 4. Prestige — HTML affiliation scan (nightly agent runs after HTML pages exist)
  const prestigeMap = await fetchPrestigeForAll(papers);

  // 5. Build output — include full paper metadata so the extension can skip
  //    the arXiv API entirely and load everything from this one CDN file.
  const output = { date: today, papers: {} };
  papers.forEach((p, i) => {
    output.papers[p.arxivId] = {
      // Metadata (extension uses these directly)
      title:      p.title,
      summary:    p.summary,
      authors:    p.authors,
      categories: p.categories,
      cat:        p.cat,
      published:  (p.published || '').slice(0, 10),
      // Scores
      applied:  Math.round(appliedScores[i] * 100) / 100,
      prestige: prestigeMap.get(p.arxivId) ?? null,
      cluster:  classifyCluster(p.title, p.summary),
      format:   classifyFormat(p.title, p.summary),
    };
  });

  // 6. Write to scores/YYYY-MM-DD.json
  mkdirSync(join(ROOT, 'scores'), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✓ Wrote ${Object.keys(output.papers).length} papers to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
