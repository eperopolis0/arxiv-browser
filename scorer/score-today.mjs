#!/usr/bin/env node
// score-today.mjs — Daily arXiv cs.AI scorer
// Fetches today's papers, scores them with Haiku, extracts prestige, classifies clusters.
// Writes scores/YYYY-MM-DD.json for the extension to consume.
//
// Usage: ANTHROPIC_API_KEY=sk-ant-... node scorer/score-today.mjs

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

const API_BASE     = 'https://export.arxiv.org/api/query';
const LISTING_URL  = 'https://arxiv.org/list/cs.AI/new';
const S2_BATCH_URL = 'https://api.semanticscholar.org/graph/v1/paper/batch';
const S2_API_KEY   = process.env.S2_API_KEY || null;

// ── Fetch helpers ──────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, ms = 30000, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const resp = await fetch(url, { ...opts, signal: ctrl.signal });
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

  // Split on <dl id='articles'> — take sections 1+2 (New + Cross), skip 3 (Replacements)
  const dlSections = html.split("<dl id='articles'>");
  const newAndCross = dlSections.slice(1, 3).join(' ');
  const idMatches = [...newAndCross.matchAll(/href\s*="\/abs\/(\d{4}\.\d{4,6})(?:v\d+)?"/g)];
  const ids = [...new Set(idMatches.map(m => m[1]))];
  console.log(`[listing] ${ids.length} IDs extracted`);
  return { count, ids };
}

// ── arXiv API — fetch full metadata by ID list ─────────────────────────────────

function xmlText(m) {
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseAtomXML(xml) {
  const entries = xml.split('<entry>').slice(1);
  const papers = [];
  for (const e of entries) {
    const id       = (/<id[^>]*>\s*([\s\S]*?)\s*<\/id>/.exec(e) || [])[1] || '';
    const arxivId  = id.replace('http://arxiv.org/abs/', '').replace(/v\d+$/, '').trim();
    const published= (/<published[^>]*>([\s\S]*?)<\/published>/.exec(e) || [])[1]?.trim() || '';
    const updated  = (/<updated[^>]*>([\s\S]*?)<\/updated>/.exec(e)   || [])[1]?.trim() || '';
    const title    = xmlText(/<title[^>]*>([\s\S]*?)<\/title>/.exec(e));
    const summary  = xmlText(/<summary[^>]*>([\s\S]*?)<\/summary>/.exec(e));
    const authorsM = [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)];
    const authors  = authorsM.map(m => m[1].trim());
    const catsM    = [...e.matchAll(/<category[^>]*term="([^"]+)"/g)];
    const categories = catsM.map(m => m[1]);
    const cat = categories.find(c => c.startsWith('cs.')) || categories[0] || 'cs.AI';
    if (arxivId && title) papers.push({ arxivId, title, summary, published, updated, authors, categories, cat });
  }
  return papers;
}

async function fetchPapers(ids) {
  // arXiv API limits id_list to ~300 at a time
  const BATCH = 300;
  const papers = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    console.log(`[arxiv] Fetching papers ${i+1}–${i+chunk.length} of ${ids.length}…`);
    const params = new URLSearchParams({ id_list: chunk.join(','), max_results: chunk.length });
    const resp = await fetchWithTimeout(`${API_BASE}?${params}`, 60000);
    if (!resp.ok) throw new Error(`arXiv API HTTP ${resp.status}`);
    const xml = await resp.text();
    papers.push(...parseAtomXML(xml));
    if (i + BATCH < ids.length) await sleep(3000); // respect arXiv rate limit
  }
  console.log(`[arxiv] ${papers.length} papers fetched`);
  return papers;
}

// ── Format + cluster classification (deterministic, no API needed) ─────────────

function classifyFormat(title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  if (/\b(benchmark|dataset|leaderboard|evaluation suite|corpus|annotated)\b/.test(text)) return 'benchmark';
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
  { name:'Audio & Speech',           keys:['speech recognit','speech synthesis','speech emotion','emotion recognit','text-to-speech','speaker verif','speaker diariz','audio classif','audio-language','audio model','sound event','music generat','acoustic model','asr','tts','voice conver','codec','prosody','audio','sound','music','speaker'] },
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

// ── Prestige — S2 affiliations ─────────────────────────────────────────────────

const PRESTIGE_TIER3 = [
  'anthropic','openai','deepmind','google deepmind','google brain',
  'meta ai','fundamental ai research','fair ',
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
  'meta ai','fundamental ai research',
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
  return 1;
}

function scoreTierFromAffsAndCitations(affiliations, maxCitations) {
  if (affiliations?.length) {
    const text = affiliations.join(' ').toLowerCase();
    for (const kw of PRESTIGE_TIER3) { if (text.includes(kw)) return 2; } // S2 path caps at 2
    for (const kw of PRESTIGE_TIER2) { if (text.includes(kw)) return 2; }
  }
  if (maxCitations >= 1000) return 2;
  if (affiliations?.length) return 1;
  return null;
}

async function fetchS2Prestige(papers) {
  const prestigeMap = new Map();
  if (!papers.length) return prestigeMap;
  const ids = papers.map(p => `ARXIV:${p.arxivId}`);
  const BATCH = 500;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (S2_API_KEY) headers['x-api-key'] = S2_API_KEY;
      const resp = await fetchWithTimeout(
        S2_BATCH_URL + '?fields=authors.affiliations,authors.citationCount', 30000,
        { method: 'POST', headers, body: JSON.stringify({ ids: chunk }) }
      );
      if (!resp.ok) { console.warn(`[s2] HTTP ${resp.status} — skipping`); break; }
      const data = await resp.json();
      let matched = 0;
      data.forEach((paper, idx) => {
        if (!paper) return;
        const arxivId = chunk[idx].replace('ARXIV:', '');
        const authors = paper.authors || [];
        const allAffs = authors.flatMap(a => (a.affiliations || []).map(af => af.name || af));
        const maxCite = Math.max(0, ...authors.map(a => a.citationCount || 0));
        const tier = scoreTierFromAffsAndCitations(allAffs, maxCite);
        if (tier !== null) { prestigeMap.set(arxivId, tier); matched++; }
      });
      console.log(`[s2] ${matched}/${chunk.length} papers scored`);
    } catch (e) {
      console.warn(`[s2] Failed (${e.message}) — skipping prestige for this batch`);
    }
    if (i + BATCH < ids.length) await sleep(2000);
  }
  return prestigeMap;
}

// ── Prestige — HTML affiliation scan (upgrades tier to 3 if frontier lab found) ─

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
    const resp = await fetchWithTimeout(`https://arxiv.org/html/${arxivId}`, 15000, {
      headers: { Range: 'bytes=0-131071' },
    });
    if (resp.status !== 200 && resp.status !== 206) return null;
    const text = await resp.text();
    const authorsBlock = extractBetweenDivs(text, 'ltx_authors', 'ltx_abstract') || '';
    const scanSource   = authorsBlock || text;
    let affiliationText = '';
    const affRe = /<span[^>]*ltx_role_affiliation[^>]*>([\s\S]*?)<\/span>/gi;
    let affM;
    while ((affM = affRe.exec(scanSource)) !== null) {
      affiliationText += ' ' + affM[1].replace(/<[^>]+>/g, ' ');
    }
    if (!affiliationText.trim()) affiliationText = scanSource.replace(/<[^>]+>/g, ' ');
    const emailText = (scanSource.match(/\b[\w.+%-]+@[\w-]+\.[\w.]+\b/gi) || []).join(' ');
    if (!affiliationText.trim() && !emailText) return null;
    return scoreTierFromText(affiliationText + ' ' + emailText);
  } catch (e) {
    return null;
  }
}

async function upgradePrestigeWithHTML(papers, s2Map) {
  // Only fetch HTML for papers where S2 didn't confirm tier 3 already.
  // Frontier labs often post HTML versions — catching them here is cheap.
  const needsHTML = papers.filter(p => (s2Map.get(p.arxivId) ?? 0) < 3);
  console.log(`[html] Checking ${needsHTML.length} papers for tier-3 affiliations…`);
  const BATCH = 10;
  const result = new Map(s2Map);
  for (let i = 0; i < needsHTML.length; i += BATCH) {
    const chunk = needsHTML.slice(i, i + BATCH);
    await Promise.all(chunk.map(async p => {
      const tier = await fetchHTMLPrestige(p.arxivId);
      if (tier !== null) result.set(p.arxivId, Math.max(tier, result.get(p.arxivId) ?? 0));
    }));
    if (i + BATCH < needsHTML.length) await sleep(2000);
  }
  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
  const outPath = join(ROOT, 'scores', `${today}.json`);

  console.log(`\n=== arXiv scorer — ${today} ===\n`);

  // 1. Get today's paper IDs from listing page
  const { ids } = await fetchTodayListing();
  if (!ids.length) { console.error('No IDs found — exiting'); process.exit(1); }

  // 2. Fetch metadata
  const papers = await fetchPapers(ids);
  if (!papers.length) { console.error('No papers fetched — exiting'); process.exit(1); }

  // 3. Score applied dimension with Haiku
  const appliedScores = await scoreAllWithHaiku(papers);

  // 4. Prestige — S2 first, then HTML upgrade to tier 3
  const s2Map = await fetchS2Prestige(papers);
  const prestigeMap = await upgradePrestigeWithHTML(papers, s2Map);

  // 5. Build output
  const output = { date: today, papers: {} };
  papers.forEach((p, i) => {
    output.papers[p.arxivId] = {
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
