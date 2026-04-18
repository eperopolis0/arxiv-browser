// ═══════════════════════════════════════════════════════
// PAPER STORAGE & CONSTANTS
// ═══════════════════════════════════════════════════════

// ET-aligned date — matches arXiv's publication calendar so the date doesn't
// flip at 8 PM ET (midnight UTC) before the listing has actually rotated.
function arxivDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

let PAPERS = [];

// Full-spectrum arc: deep blue → teal → green → olive → amber → sienna → red.
// Order in ALL_CATS matches this gradient: pure mechanism (blue) → pure application (red).
let CAT_COLOR  = {
  'cs.LG': 'oklch(0.48 0.160 262)',  // deep blue         (ML Methods)
  'cs.CL': 'oklch(0.54 0.150 245)',  // steel blue        (NLP)
  'cs.IR': 'oklch(0.61 0.130 210)',  // blue-teal         (Retrieval)
  'cs.AI': 'oklch(0.62 0.090 185)',  // teal/cyan         (General AI)
  'cs.CV': 'oklch(0.62 0.110 140)',  // blue-green        (Vision)
  'cs.HC': 'oklch(0.63 0.130  68)',  // amber/gold        (HCI)
  'cs.CR': 'oklch(0.58 0.150  38)',  // burnt sienna      (Safety)
  'cs.RO': 'oklch(0.49 0.160  22)',  // deep red-orange   (Robotics)
};
const CAT_LABEL  = { 'cs.CL':'NLP','cs.CV':'Vision','cs.RO':'Robotics','cs.CR':'Safety','cs.LG':'ML Methods','cs.AI':'General AI','cs.HC':'HCI','cs.IR':'Retrieval' };
const FMT_LABEL  = { empirical:'Empirical', benchmark:'Benchmark', survey:'Survey', theory:'Theory', position:'Position' };
let FMT_COLOR  = {
  theory:    'oklch(0.50 0.150 258)',  // blue
  position:  'oklch(0.58 0.130 248)',  // steel blue
  empirical: 'oklch(0.64 0.110  76)',  // warm gold — catch-all leans applied; visible at all prestige sizes
  benchmark: 'oklch(0.64 0.120  55)',  // amber
  survey:    'oklch(0.58 0.140  32)',  // sienna
};
const D3_SYMBOL  = { empirical:d3.symbolCircle, benchmark:d3.symbolTriangle, survey:d3.symbolSquare, theory:d3.symbolCross, position:d3.symbolDiamond };

let ALL_CLUSTERS = [];
const ALL_CATS     = ['cs.LG','cs.CL','cs.IR','cs.AI','cs.CV','cs.HC','cs.CR','cs.RO'];
const ALL_FORMATS  = ['theory','position','empirical','benchmark','survey'];
const ALL_PRESTIGE = [3, 2, 1];
const PRESTIGE_LABEL  = { 3:'Frontier ✦✦✦', 2:'Elite ✦✦', 1:'Community ✦' };
const PRESTIGE_LABEL_R = PRESTIGE_LABEL;
const PRESTIGE_COLOR = { 3:'rgba(196,148,40,0.95)', 2:'rgba(232,217,188,0.70)', 1:'rgba(232,217,188,0.42)' };
let activeCats     = new Set(); // empty = show all; non-empty = show only selected
let activeFormats  = new Set();
let activePrestige = new Set();
let starFilterActive = false;
let colorMode = 'field'; // 'cluster' | 'field' | 'score'
let CLUSTER_COLOR = {};
const activeClusters = new Set();
let searchQuery = '';

// ═══════════════════════════════════════════════════════
// LOADING STATE
// ═══════════════════════════════════════════════════════
let _loadingTimer = null;
function showLoading(msg) {
  const overlay = document.getElementById('loading-overlay');
  document.getElementById('loading-msg').textContent = msg;
  const sub = document.getElementById('loading-sub');
  const retryBtn = document.getElementById('loading-retry');
  if (sub) sub.textContent = '';
  if (retryBtn) retryBtn.style.display = 'none';
  overlay.classList.add('visible');
  let secs = 0;
  clearInterval(_loadingTimer);
  _loadingTimer = setInterval(() => {
    secs++;
    if (sub) sub.textContent = `${secs}s elapsed…`;
    if (retryBtn && secs === 8) retryBtn.style.display = 'inline-block';
  }, 1000);
}
function hideLoading() {
  clearInterval(_loadingTimer);
  document.getElementById('loading-overlay').classList.remove('visible');
}
// Show a live countdown when arXiv rate-limits us, then auto-retry.
// Driven by the UI (not the service worker) so it survives SW death.
function startCountdown(retryAfter) {
  clearInterval(_loadingTimer);
  document.getElementById('loading-overlay').classList.add('visible');
  const retryBtn = document.getElementById('loading-retry');
  if (retryBtn) retryBtn.style.display = 'none';
  _loadingTimer = setInterval(() => {
    const secsLeft = Math.ceil((retryAfter - Date.now()) / 1000);
    document.getElementById('loading-msg').textContent = 'Rate limited by arXiv';
    const sub = document.getElementById('loading-sub');
    if (secsLeft > 0) {
      if (sub) sub.textContent = `Auto-retry in ${secsLeft}s\u2026`;
    } else {
      clearInterval(_loadingTimer);
      if (sub) sub.textContent = 'Retrying\u2026';
      // Cooldown expired — clear error/lock state, keep processedPapers so
      // stale papers stay visible while we retry.
      chrome.storage.local.set({ fetchInProgress: false, fetchRetryAfter: null, fetchError: null }, () => {
        chrome.runtime.sendMessage({ action: 'refresh' });
        setTimeout(() => loadAndRender(), 500);
      });
    }
  }, 1000);
}

function forceRefresh() {
  // Don't hammer arXiv if we're still in a 429 cooldown
  chrome.storage.local.get(['fetchRetryAfter'], ({ fetchRetryAfter }) => {
    if (fetchRetryAfter && Date.now() < fetchRetryAfter) {
      startCountdown(fetchRetryAfter);
      return;
    }
    document.getElementById('loading-msg').textContent = 'Retrying\u2026';
    const retryBtn = document.getElementById('loading-retry');
    if (retryBtn) retryBtn.style.display = 'none';
    // Don't wipe processedPapers — stale papers are better than a blank screen
    // while the retry is in flight.
    chrome.storage.local.set({ fetchInProgress: false, fetchError: null, lastFetch: null }, () => {
      chrome.runtime.sendMessage({ action: 'refresh' });
      setTimeout(() => loadAndRender(), 500);
    });
  });
}
function showError(msg) {
  if (msg && msg.includes('429')) {
    chrome.storage.local.get(['fetchRetryAfter'], ({ fetchRetryAfter }) => {
      if (fetchRetryAfter && Date.now() < fetchRetryAfter) {
        startCountdown(fetchRetryAfter);
      } else {
        showLoading('Rate limited by arXiv \u2014 click Retry to try again');
      }
    });
    return;
  }
  showLoading('Error: ' + msg);
}

// ═══════════════════════════════════════════════════════
// PROCESSING PIPELINE (fallback when service worker
// was killed before it could store processedPapers)
// ═══════════════════════════════════════════════════════
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
function scoreApplied(title, summary, cat, format) {
  const text = (title + ' ' + summary).toLowerCase();
  // Format prior: classifyFormat uses word-boundary regex — stronger signal than keyword counts
  const FORMAT_PRIOR = { theory:0.15, survey:0.28, empirical:0.32, benchmark:0.58, position:0.38 };
  const base = FORMAT_PRIOR[format] ?? 0.28;
  // Category nudge: some fields are structurally applied/mechanistic regardless of abstract text
  const CAT_ADJ = { 'cs.RO':0.12, 'cs.HC':0.10, 'cs.IR':0.06, 'cs.CV':0.04, 'cs.LG':-0.04 };
  const catAdj = CAT_ADJ[cat] ?? 0;
  const a = ['deploy','real-world','production','application','clinical','medical','healthcare','commercial','on-device','edge','robot','autonomous','user study','human evaluation','user interface','open-source','open source','released','api','pipeline','end-to-end system','in the wild','case study','field study','we implement','system design'].filter(t=>text.includes(t)).length;
  const th = ['theorem','lemma','proof','regret','sample complexity','convergence rate','upper bound','lower bound','pac learning','formally','asymptotic','theoretical analysis','minimax','information-theoretic','information theoretic','we prove','we show that','hardness','np-hard','complexity class','tight bound','impossibility','approximation ratio','competitive ratio','optimal algorithm','complexity analysis'].filter(t=>text.includes(t)).length;
  return Math.min(1, Math.max(0, base + catAdj + a * 0.11 - th * 0.18));
}
function scoreRelevance(cat, title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  const hi  = ['agent','multimodal','reasoning','language model','llm','alignment','rlhf','instruction follow','world model','chain-of-thought','in-context','emergent'];
  const mid = ['classification','detection','segmentation','benchmark','fine-tun','transfer','distill'];
  const lo  = ['sodium','battery','chemical','material','crystal','protein','genomic','fluid','quantum circuit','routing protocol'];
  const h = hi.filter(t=>text.includes(t)).length;
  const m = mid.filter(t=>text.includes(t)).length;
  const l = lo.filter(t=>text.includes(t)).length;
  const boost = ['cs.AI','cs.CL'].includes(cat) ? 0.05 : 0;
  return Math.min(1, Math.max(0.05, 0.35 + h * 0.10 + m * 0.03 - l * 0.15 + boost));
}
// Personalized Y-axis score: Jaccard similarity between a paper and the bag
// of all starred papers' tokens.  Returns null when no stars exist so the
// caller can fall back to the static relevance score.
//
// Jaccard sims between short academic texts typically run 0.01–0.12.
// We scale by ×10 to map that range onto [0.1, 1.0] on the Y axis.
function scoreAffinity(paper, starredData) {
  const entries = Object.values(starredData);
  if (!entries.length) return null;
  const paperTokens = new Set(tokenize(paper.title + ' ' + (paper._summary || '')));
  if (!paperTokens.size) return 0.1;
  let maxSim = 0;
  for (const d of entries) {
    const sTokens = new Set(tokenize(d.title + ' ' + (d.summary || '')));
    if (!sTokens.size) continue;
    let overlap = 0;
    paperTokens.forEach(t => { if (sTokens.has(t)) overlap++; });
    const union = new Set([...paperTokens, ...sTokens]).size;
    const sim = union ? overlap / union : 0;
    if (sim > maxSim) maxSim = sim;
  }
  return Math.min(0.95, Math.max(0.05, maxSim * 10));
}

const STOPWORDS = new Set(['a','an','the','in','on','at','to','for','of','with','and','or','is','are','was','were','this','that','these','those','we','our','it','its','by','from','as','be','been','has','have','had','not','but','which','also','can','using','based','via','paper','propose','model','method','approach','show','shows','learn','learning','deep','new','two','one','three','large','small','high','low','first','present','achieve','result','performance','training','train','trained','task','tasks','data','dataset','set','use','used','different','across','between','both','more','than','without','into','each','other','such','whether','while','when','where','then','their','they','them','thus','however','here','there']);
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(t => t.length > 3 && !STOPWORDS.has(t));
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
function classifyPaper(title, summary, cat) {
  const text = (title + ' ' + summary).toLowerCase();
  let best = null, bestScore = 0;
  for (const {name,keys} of CLUSTER_MAP) {
    const score = keys.filter(k => text.includes(k)).length;
    if (score > bestScore) { bestScore=score; best=name; }
  }
  return best || 'General ML';
}
function stripLatex(text) {
  if (!text) return text;
  return text
    .replace(/\\(?:emph|textbf|textit|texttt|text|mathrm|mathbf|mathit)\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')  // any other \cmd{content} → content
    .replace(/\\[a-zA-Z]+\s*/g, '')              // bare \commands → remove
    .replace(/[{}]/g, '');                        // stray braces
}

function processRawPapers(rawPapers) {
  if (!rawPapers.length) return [];
  return rawPapers.map(p => {
    const title   = stripLatex(p.title   || '');
    const summary = stripLatex(p.summary || '');
    const cat = (p.categories||[]).find(c=>c.startsWith('cs.'))||p.categories?.[0]||'cs.AI';
    const cluster = classifyPaper(title, summary, cat);
    const format = classifyFormat(title, summary);
    return { id:p.arxivId, title, gist:summary.slice(0,200).replace(/\s+/g,' ').toLowerCase(),
      cat, format, applied:scoreApplied(title, summary, cat, format),
      relevance:scoreRelevance(cat, title, summary),
      starred:false, clusters:[cluster], _absLink:p.absLink||'https://arxiv.org/abs/'+p.arxivId,
      _pdfLink:p.pdfLink||'https://arxiv.org/pdf/'+p.arxivId,
      _authors:(p.authors||[]).slice(0,3).join(', '), _summary:summary };
  });
}

// ═══════════════════════════════════════════════════════
// STAR PERSISTENCE
// Starred IDs are stored by ID so they survive across daily paper refreshes.
// Starred paper *content* (title + summary) is stored separately so affinity
// scoring can reference papers from previous days even when they're no longer
// in today's list.
// ═══════════════════════════════════════════════════════
const STAR_KEY      = 'arxiv-map-starred';
const STAR_DATA_KEY = 'arxiv-map-starred-data'; // id → { title, summary }
let _starredData    = {}; // in-memory mirror, loaded once and kept in sync

function loadStarred() {
  try {
    const ids = new Set(JSON.parse(localStorage.getItem(STAR_KEY) || '[]'));
    PAPERS.forEach(p => { if (ids.has(p.id)) p.starred = true; });
    _starredData = JSON.parse(localStorage.getItem(STAR_DATA_KEY) || '{}');
  } catch(e) {}
}
function saveStarred() {
  try {
    localStorage.setItem(STAR_KEY, JSON.stringify(PAPERS.filter(p=>p.starred).map(p=>p.id)));
    localStorage.setItem(STAR_DATA_KEY, JSON.stringify(_starredData));
  } catch(e) {}
}
function toggleStar(p) {
  p.starred = !p.starred;
  if (p.starred) {
    _starredData[p.id] = {
      title:      p.title,
      summary:    p._summary || '',
      absLink:    p._absLink || 'https://arxiv.org/abs/' + p.id,
      pdfLink:    p._pdfLink || '',
      authors:    p._authors || '',
      cat:        p.cat,
      clusters:   p.clusters,
      dateStarred: new Date().toISOString().slice(0, 10)
    };
  } else {
    delete _starredData[p.id];
  }
  saveStarred();
  dotsG.selectAll('path.star-glow').filter(d => d === p)
    .attr('opacity', p.starred ? 0.30 : 0);
  if (pinned === p) showTip(lastTipEvt, p);
  const n = PAPERS.filter(p=>p.starred).length;
  const sc = document.getElementById('star-count');
  if (sc) sc.textContent = n;
  // Update drawer count + re-render if open
  const countEl = document.getElementById('starred-drawer-count');
  if (countEl) countEl.textContent = Object.keys(_starredData).length;
  if (document.getElementById('starred-drawer')?.classList.contains('open')) buildStarredDrawer();
  applyJitter();
  drawBlobs();
  animateDots();
  updateAxisLabel();
  renderSidebar();
}

// ═══════════════════════════════════════════════════════
// STARRED PAPERS DRAWER
// ═══════════════════════════════════════════════════════
function openStarredDrawer() {
  buildStarredDrawer();
  document.getElementById('starred-drawer').classList.add('open');
  const countEl = document.getElementById('starred-drawer-count');
  if (countEl) countEl.textContent = Object.keys(_starredData).length;
}
function closeStarredDrawer() {
  document.getElementById('starred-drawer').classList.remove('open');
}

function buildStarredDrawer() {
  const list = document.getElementById('starred-list');
  if (!list) return;
  const entries = Object.entries(_starredData);
  if (!entries.length) {
    list.innerHTML = '<div class="se-empty">No starred papers yet.<br>Star a paper from the tooltip<br>to save it here.</div>';
    return;
  }
  // Most recent first
  entries.sort((a, b) => (b[1].dateStarred || '').localeCompare(a[1].dateStarred || ''));
  list.innerHTML = entries.map(([id, d]) => {
    const abs  = esc(d.absLink || 'https://arxiv.org/abs/' + id);
    const pdf  = d.pdfLink ? esc(d.pdfLink) : '';
    const meta = [d.dateStarred, d.clusters?.[0], d.authors].filter(Boolean).join(' · ');
    return `<div class="se-entry">
      <a class="se-title" href="${abs}" target="_blank">${esc(d.title)}</a>
      <div class="se-meta">${esc(meta)}</div>
      <div class="se-actions">
        <a class="se-btn" href="${abs}" target="_blank">arXiv ↗</a>
        ${pdf ? `<a class="se-btn" href="${pdf}" target="_blank">PDF ↗</a>` : ''}
        <button class="se-btn se-unstar" data-id="${esc(id)}">✕ unstar</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.se-unstar').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      // If paper is in today's list, go through toggleStar for full cleanup
      const p = PAPERS.find(p => p.id === id);
      if (p && p.starred) { toggleStar(p); return; }
      // Otherwise remove directly from store
      delete _starredData[id];
      saveStarred();
      const countEl = document.getElementById('starred-drawer-count');
      if (countEl) countEl.textContent = Object.keys(_starredData).length;
      applyJitter(); drawBlobs(); animateDots(); updateAxisLabel();
      buildStarredDrawer();
    });
  });
}

document.getElementById('starred-drawer-close').addEventListener('click', closeStarredDrawer);

// ═══════════════════════════════════════════════════════
// CHROME STORAGE & LOADING
// ═══════════════════════════════════════════════════════
let _renderInFlight = false;
async function loadAndRender() {
  if (_renderInFlight) return; // prevent concurrent renders from dataUpdated + countdown racing
  _renderInFlight = true;
  try {
  const data = await new Promise(r =>
    chrome.storage.local.get(['processedPapers','papers','lastFetch','lastFetchTime','fetchError','fetchInProgress','appliedHistory'], r)
  );

  if (data.processedPapers?.length > 0) {
    const today = arxivDate();
    const ageMs = data.lastFetchTime ? Date.now() - data.lastFetchTime : Infinity;
    const isStale = data.lastFetch !== today || ageMs > 20 * 60 * 60 * 1000;

    if (!isStale) {
      // Fresh cache — render immediately.
      await renderPapers(data.processedPapers, data.lastFetch, data.appliedHistory);
      return;
    }

    // Stale cache: show loading and wait for fresh data rather than rendering
    // yesterday's map only to jump when today's arrives (~3s later).
    showLoading('Fetching today\u2019s papers\u2026');
    if (!data.fetchInProgress) {
      document.getElementById('header-date').textContent = (data.lastFetch || '\u2014') + ' \u21bb';
      chrome.storage.local.set({ lastFetch: null, fetchError: null }, () => {
        chrome.runtime.sendMessage({ action: 'refresh' });
      });
    }
    // dataUpdated fires when fresh papers are stored → loadAndRender() re-called.
    return;
  }

  // Fallback: raw papers exist but service worker was killed before processing
  if (data.papers?.length > 0) {
    showLoading('Processing papers\u2026');
    await new Promise(r => setTimeout(r, 50)); // let overlay paint
    const processed = processRawPapers(data.papers);
    chrome.storage.local.set({ processedPapers: processed });
    await renderPapers(processed, data.lastFetch);
    return;
  }

  // First install / cache miss — wait for background fetch.
  // Check for 429 cooldown before showing generic error or starting fetch.
  if (data.fetchError) {
    const { fetchRetryAfter } = await new Promise(r => chrome.storage.local.get(['fetchRetryAfter'], r));
    if (fetchRetryAfter && Date.now() < fetchRetryAfter) {
      startCountdown(fetchRetryAfter);
      return;
    }
    showError(data.fetchError);
    return;
  }
  showLoading(data.fetchInProgress ? 'Fetching today\u2019s papers\u2026' : 'Starting first fetch\u2026');
  if (!data.fetchInProgress) chrome.runtime.sendMessage({ action: 'refresh' });

  // Poll up to ~5 minutes (150 × 2s). The countdown handler exits this loop
  // early if a 429 cooldown is detected.
  for (let attempt = 0; attempt < 150; attempt++) {
    await new Promise(r => setTimeout(r, 2000));
    const d = await new Promise(r => chrome.storage.local.get(['processedPapers','papers','fetchError','fetchInProgress','fetchRetryAfter','fetchStartedAt'], r));

    // Detect dead service worker: fetchInProgress stuck true but fetchStartedAt
    // is >3min old — the worker was killed mid-fetch. 3min allows for 2 API
    // chunks × 60s timeout + listing page fetch without false-firing.
    if (d.fetchInProgress && d.fetchStartedAt && (Date.now() - d.fetchStartedAt) > 3 * 60_000) {
      console.warn('[arXiv] Service worker appears dead — breaking stale lock and retrying.');
      await new Promise(r => chrome.storage.local.set({ fetchInProgress: false, fetchStartedAt: null }, r));
      chrome.runtime.sendMessage({ action: 'refresh' });
      showLoading('Retrying fetch\u2026');
      continue;
    }

    // 429 cooldown detected — hand off to countdown, exit polling
    if (d.fetchRetryAfter && Date.now() < d.fetchRetryAfter) {
      startCountdown(d.fetchRetryAfter);
      return;
    }

    if (d.fetchError) { showError(d.fetchError); return; }
    if (d.processedPapers?.length > 0) {
      const { lastFetch } = await new Promise(r => chrome.storage.local.get(['lastFetch'], r));
      await renderPapers(d.processedPapers, lastFetch);
      return;
    }
    // Papers fetched but processing killed — process here
    if (d.papers?.length > 0 && !d.fetchInProgress) {
      document.getElementById('loading-msg').textContent = 'Processing papers\u2026';
      await new Promise(r => setTimeout(r, 50));
      const processed = processRawPapers(d.papers);
      chrome.storage.local.set({ processedPapers: processed });
      const { lastFetch } = await new Promise(r => chrome.storage.local.get(['lastFetch'], r));
      await renderPapers(processed, lastFetch);
      return;
    }
  }
  showError('Timed out. Check your connection and reload.');
  } finally {
    _renderInFlight = false;
  }
}

async function renderPapers(processedPapers, lastFetch, appliedHistory) {
  // Re-enable refresh button (may have been disabled during a manual refresh)
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.classList.remove('spinning'); }

  PAPERS = processedPapers.map(p => ({
    ...p,
    title:    stripLatex(p.title    || ''),
    _summary: stripLatex(p._summary || ''),
    gist:     stripLatex(p.gist     || ''),
  }));
  loadStarred();

  ALL_CLUSTERS.length = 0;
  const seen = new Set();
  PAPERS.forEach(p => p.clusters.forEach(c => { if (!seen.has(c)) { seen.add(c); ALL_CLUSTERS.push(c); } }));

  if (lastFetch) document.getElementById('header-date').textContent = lastFetch;
  document.getElementById('vis-count').textContent = PAPERS.length;

  logScoreDistribution(PAPERS);
  logClusterDistribution(PAPERS);
  applyColorHistory(appliedHistory); // set CAT_COLOR from rolling history before building UI
  buildClusterBar();
  buildLegend();

  activeCats     = new Set(); // empty = show all; reset on each load
  activeFormats  = new Set();
  activePrestige = new Set();

  // Wire search bar once after papers load
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    searchClear.classList.toggle('visible', searchQuery.length > 0);
    updateVisibility();
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    searchClear.classList.remove('visible');
    searchInput.focus();
    updateVisibility();
  });

  hideLoading();
  draw();
  renderSidebar();
  // Prestige is now resolved by background.js at fetch time — no auto-verify here.
  // Manual click-to-verify on null prestige dots is still supported via verifyPrestige().
}

// ─── Color scale ───
// OKLCH, fixed stops. Score positions designed around where cluster/category *averages* land
// (empirically ~0.20–0.78), so the discriminating colors cluster in the range that matters.
// Individual paper extremes (0.0, 1.0) still get the endpoint colors.
// [score, L, C, H]
// Anchored to the bimodal data distribution: theoretical cluster peaks ~0.30, applied ~0.60.
// Gold crossover at 0.45 (valley between peaks) splits papers ~50-50 cool vs warm.
// Cool half: purple → blue → teal. Warm half: gold → amber → red.
const AXIS_STOPS = [
  [0.00, 0.48, 0.18, 305],  // purple
  [0.17, 0.50, 0.17, 265],  // blue
  [0.33, 0.60, 0.14, 195],  // teal
  [0.50, 0.65, 0.14,  78],  // gold    ← midpoint: warm/cool crossover
  [0.67, 0.62, 0.13,  45],  // amber
  [0.83, 0.55, 0.14,  25],  // sienna
  [1.00, 0.48, 0.16,  20],  // deep red
];

function logClusterDistribution(papers) {
  const groups = {};
  papers.forEach(p => {
    const c = p.clusters?.[0] || 'General ML';
    if (!groups[c]) groups[c] = [];
    groups[c].push(p);
  });

  const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  console.log(`[arXiv] Cluster distribution (${sorted.length} clusters):`);
  sorted.forEach(([name, ps]) => {
    const mean = (ps.reduce((s, p) => s + (p.applied ?? 0.5), 0) / ps.length).toFixed(3);
    console.log(`[arXiv]   ${name.padEnd(26)} n=${String(ps.length).padStart(3)}  μ=${mean}`);
  });

  // Spotlight the fallback — show titles so we can see what's slipping through
  const fallback = groups['General ML'] || [];
  if (fallback.length) {
    console.log(`[arXiv] General ML titles (${fallback.length} papers — potential cluster gaps):`);
    fallback
      .sort((a, b) => (b.applied ?? 0.5) - (a.applied ?? 0.5))
      .forEach(p => console.log(`[arXiv]   [${(p.applied ?? 0.5).toFixed(2)}] ${p.title}`));
  }
}

function logScoreDistribution(papers) {
  const scores = papers.map(p => p.applied ?? 0.5).sort((a, b) => a - b);
  const n = scores.length;
  const pct = p => scores[Math.round(p * (n - 1))].toFixed(3);
  console.log(`[arXiv] Score distribution (n=${n}): p10=${pct(0.1)} p25=${pct(0.25)} p50=${pct(0.5)} p75=${pct(0.75)} p90=${pct(0.9)}`);
  const buckets = Array(10).fill(0);
  scores.forEach(s => buckets[Math.min(9, Math.floor(s * 10))]++);
  console.log('[arXiv] Histogram:', buckets.map((c, i) => `${(i * 0.1).toFixed(1)}:${c}`).join('  '));
  console.log('[arXiv] Axis stops:', AXIS_STOPS.map(([t]) => t.toFixed(3)).join('  '));
  const fmtGroups = {};
  papers.forEach(p => { (fmtGroups[p.format] = fmtGroups[p.format] || []).push(p.applied ?? 0.5); });
  Object.entries(fmtGroups)
    .sort(([,a],[,b]) => (a.reduce((s,v)=>s+v,0)/a.length) - (b.reduce((s,v)=>s+v,0)/b.length))
    .forEach(([fmt, ss]) => {
      ss.sort((a,b)=>a-b);
      const mean = (ss.reduce((s,v)=>s+v,0)/ss.length).toFixed(3);
      const med  = ss[Math.floor(ss.length/2)].toFixed(3);
      console.log(`[arXiv]   ${fmt.padEnd(10)} n=${ss.length}  mean=${mean}  median=${med}`);
    });
}

function axisColor(score) {
  const t = Math.max(0, Math.min(1, score));
  const stops = AXIS_STOPS;
  let i = stops.length - 2;
  for (let j = 0; j < stops.length - 1; j++) {
    if (t <= stops[j + 1][0]) { i = j; break; }
  }
  const [t0, l0, c0, h0] = stops[i];
  const [t1, l1, c1, h1] = stops[i + 1];
  const u = (t - t0) / (t1 - t0);
  return `oklch(${(l0 + u * (l1 - l0)).toFixed(3)} ${(c0 + u * (c1 - c0)).toFixed(3)} ${Math.round(h0 + u * (h1 - h0))})`;
}

function dotColor(d) {
  const t = d._colorT ?? d._x ?? d.applied ?? 0.5;
  if (colorMode === 'cluster') return CLUSTER_COLOR[d.clusters?.[0]] || axisColor(t);
  if (colorMode === 'score')   return axisColor(t);
  return CAT_COLOR[d.cat] || axisColor(t); // 'field' — unknown cats get score color
}

// Returns a bright, pale version of a dot's color for hover/pin highlight.
// Parses oklch() directly (d3.hsl can't handle oklch strings).
function highlightColor(d) {
  const c = dotColor(d);
  const m = c.match(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.-]+)\)/);
  if (m) {
    const L = Math.min(0.92, +m[1] + 0.38).toFixed(3);
    const C = (+m[2] * 0.45).toFixed(3);
    return `oklch(${L} ${C} ${m[3]})`;
  }
  return '#ffffff';
}

function applyColorHistory(history) {
  if (!history?.length) return;
  const catSum = {}, catCount = {}, fmtSum = {}, fmtCount = {};
  history.forEach(({ cats, formats }) => {
    Object.entries(cats || {}).forEach(([k, v]) => {
      if (v !== null) { catSum[k] = (catSum[k] || 0) + v; catCount[k] = (catCount[k] || 0) + 1; }
    });
    Object.entries(formats || {}).forEach(([k, v]) => {
      if (v !== null) { fmtSum[k] = (fmtSum[k] || 0) + v; fmtCount[k] = (fmtCount[k] || 0) + 1; }
    });
  });
  Object.keys(CAT_COLOR).forEach(cat => {
    if (catCount[cat]) CAT_COLOR[cat] = axisColor(catSum[cat] / catCount[cat]);
  });
  Object.keys(FMT_COLOR).forEach(fmt => {
    if (fmtCount[fmt]) FMT_COLOR[fmt] = axisColor(fmtSum[fmt] / fmtCount[fmt]);
  });
  const catAvg = cat => catCount[cat] ? catSum[cat] / catCount[cat] : 0.5;
  const fmtAvg = fmt => fmtCount[fmt] ? fmtSum[fmt] / fmtCount[fmt] : 0.5;
  ALL_CATS.sort((a, b) => catAvg(a) - catAvg(b));
  ALL_FORMATS.sort((a, b) => fmtAvg(a) - fmtAvg(b));

  // Rebuild the axis gradient using actual category colors positioned at their
  // mean applied scores — so the bar reflects what you see on the map today.
  rebuildAxisGradient(cat => ({ score: catAvg(cat), color: CAT_COLOR[cat] }));
}

function rebuildAxisGradient(catInfo) {
  // Collect (score, color) pairs from all categories that have data
  const stops = Object.keys(CAT_COLOR)
    .map(cat => catInfo(cat))
    .filter(d => d.color && d.score != null)
    .sort((a, b) => a.score - b.score);

  if (!stops.length) return;

  // Remove existing stops and replace with category-derived ones
  _axisGrad.selectAll('stop').remove();
  // Anchor at 0 and 1 with the extreme colors
  _axisGrad.append('stop').attr('offset', '0%').attr('stop-color', axisColor(0));
  stops.forEach(({ score, color }) => {
    _axisGrad.append('stop')
      .attr('offset', `${(score * 100).toFixed(1)}%`)
      .attr('stop-color', color);
  });
  _axisGrad.append('stop').attr('offset', '100%').attr('stop-color', axisColor(1));
}

function buildClusterBar() {
  const clusterBarEl = document.getElementById('cluster-bar');
  clusterBarEl.innerHTML = '';
  const clusterCount = name => PAPERS.filter(p => p.clusters.includes(name)).length;
  const sortedClusters = [...ALL_CLUSTERS].sort((a,b) => clusterCount(b) - clusterCount(a) || a.localeCompare(b));
  CLUSTER_COLOR = {};
  sortedClusters.forEach(name => {
    const members  = PAPERS.filter(p => p.clusters.includes(name));
    CLUSTER_COLOR[name] = '#9BAAB8'; // neutral — cluster buttons match blob color
    const btn = document.createElement('button');
    btn.className   = 'cluster-btn';
    btn.style.color = CLUSTER_COLOR[name];
    btn.innerHTML   = esc(name) + '<span class="cb-count">' + members.length + '</span>';
    btn.dataset.cluster = name;
    btn.addEventListener('click', () => {
      activeClusters.has(name) ? activeClusters.delete(name) : activeClusters.add(name);
      btn.classList.toggle('active', activeClusters.has(name));
      updateVisibility();
    });
    clusterBarEl.appendChild(btn);
  });
}

// ─── Build legend ───
function buildLegend() {
  const legendEl = document.getElementById('legend-content');
  legendEl.innerHTML = '';

  const fieldSec = document.createElement('div');
  fieldSec.innerHTML = '<div class="leg-section-title"><span class="title-noun">Field</span> \u00b7 <span class="title-attr">color</span></div>';
  const fieldBtns = document.createElement('div');
  fieldBtns.className = 'leg-btns single-col';
  ALL_CATS.forEach(cat => {
    const count = PAPERS.filter(p => p.cat === cat).length;
    if (!count) return;
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.style.color = CAT_COLOR[cat];
    btn.style.borderColor = CAT_COLOR[cat];
    btn.innerHTML = CAT_LABEL[cat] + ' <span class="fb-count">' + count + '</span>';
    btn.dataset.cat = cat;
    btn.addEventListener('click', () => {
      activeCats.has(cat) ? activeCats.delete(cat) : activeCats.add(cat);
      btn.classList.toggle('active', activeCats.has(cat));
      updateVisibility();
    });
    fieldBtns.appendChild(btn);
  });
  fieldSec.appendChild(fieldBtns);
  legendEl.appendChild(fieldSec);

  const fmtIcon = fmt => {
    const path = d3.symbol().type(D3_SYMBOL[fmt]).size(88)();
    return `<svg class="fb-icon" viewBox="-8 -8 16 16" width="1em" height="1em" style="flex-shrink:0;display:block"><path d="${path}" fill="currentColor"/></svg>`;
  };
  const fmtSec = document.createElement('div');
  fmtSec.innerHTML = '<div class="leg-section-title"><span class="title-noun">Format</span> \u00b7 <span class="title-attr">shape</span></div>';
  const fmtBtns = document.createElement('div');
  fmtBtns.className = 'leg-btns single-col';
  ALL_FORMATS.forEach(fmt => {
    const count = PAPERS.filter(p => p.format === fmt).length;
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.style.color = FMT_COLOR[fmt];
    btn.style.borderColor = FMT_COLOR[fmt];
    btn.innerHTML = FMT_LABEL[fmt] + ' ' + fmtIcon(fmt) + '<span class="fb-count">' + count + '</span>';
    btn.dataset.format = fmt;
    btn.addEventListener('click', () => {
      activeFormats.has(fmt) ? activeFormats.delete(fmt) : activeFormats.add(fmt);
      btn.classList.toggle('active', activeFormats.has(fmt));
      updateVisibility();
    });
    fmtBtns.appendChild(btn);
  });
  fmtSec.appendChild(fmtBtns);
  legendEl.appendChild(fmtSec);

  // ── Prestige · size ──
  const prestSec = document.createElement('div');
  prestSec.innerHTML = '<div class="leg-section-title"><span class="title-noun">Prestige</span> \u00b7 <span class="title-attr">size</span></div>';
  const prestBtns = document.createElement('div');
  prestBtns.className = 'leg-btns single-col';
  ALL_PRESTIGE.forEach(tier => {
    const count = PAPERS.filter(p => (p.prestige ?? 1) === tier).length;
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.style.color = PRESTIGE_COLOR[tier];
    btn.style.borderColor = PRESTIGE_COLOR[tier];
    btn.innerHTML = PRESTIGE_LABEL[tier] + ' <span class="fb-count">' + count + '</span>';
    btn.dataset.prestige = tier;
    btn.addEventListener('click', () => {
      activePrestige.has(tier) ? activePrestige.delete(tier) : activePrestige.add(tier);
      btn.classList.toggle('active', activePrestige.has(tier));
      updateVisibility();
    });
    prestBtns.appendChild(btn);
  });
  prestSec.appendChild(prestBtns);
  legendEl.appendChild(prestSec);

  // ── Starred ──
  const starWrapper = document.createElement('div');
  starWrapper.innerHTML = '<div class="leg-section-title"><span class="title-noun">Favorite</span> \u00b7 <span class="title-attr">starred</span></div>';
  const starSec = document.createElement('div');
  starSec.className = 'leg-btns single-col';
  const starN = PAPERS.filter(p => p.starred).length;
  const starBtn = document.createElement('button');
  starBtn.className = 'filter-btn star-btn';
  starBtn.id = 'star-filter-btn';
  starBtn.innerHTML = 'Today \u2605 <span class="fb-count" id="star-count">' + starN + '</span>';
  starBtn.addEventListener('click', () => {
    starFilterActive = !starFilterActive;
    starBtn.classList.toggle('active', starFilterActive);
    updateVisibility();
  });
  const drawerBtn = document.createElement('button');
  drawerBtn.className = 'filter-btn star-btn';
  drawerBtn.id = 'view-starred-btn';
  const allStarN = Object.keys(_starredData).length;
  drawerBtn.innerHTML = 'All\u2011Time \u2605 <span class="fb-count">' + allStarN + '</span>';
  drawerBtn.addEventListener('click', () => {
    const drawer = document.getElementById('starred-drawer');
    drawer.classList.contains('open') ? closeStarredDrawer() : openStarredDrawer();
  });
  starSec.appendChild(starBtn);
  starSec.appendChild(drawerBtn);
  starWrapper.appendChild(starSec);
  legendEl.appendChild(starWrapper);

}

// ═══════════════════════════════════════════════════════
// SVG & ZOOM SETUP
// ═══════════════════════════════════════════════════════
const svg     = d3.select('#chart');
const clusterNameEl = document.getElementById('cluster-name-display');
const chartEl = document.getElementById('chart-area');
const M       = { top:8, right:4, bottom:24, left:4 };

const defs = svg.append('defs');
defs.append('filter').attr('id','blob-blur').append('feGaussianBlur').attr('stdDeviation', 10);
const glowFilter = defs.append('filter').attr('id','blob-glow').attr('x','-30%').attr('y','-30%').attr('width','160%').attr('height','160%');
glowFilter.append('feGaussianBlur').attr('in','SourceGraphic').attr('stdDeviation', 16).attr('result','blur');
const glowMerge = glowFilter.append('feMerge');
glowMerge.append('feMergeNode').attr('in','blur');
glowMerge.append('feMergeNode').attr('in','SourceGraphic');

const rootG    = svg.append('g');
const blobsG   = rootG.append('g');
const gridG    = rootG.append('g');
const dotsG    = rootG.append('g');
const axisG    = svg.append('g');

// Horizontal color gradient for x-axis bar (Mechanism → Application)
// Built once from AXIS_STOPS; reused by every draw().
const _axisGrad = defs.append('linearGradient').attr('id','axis-x-grad')
  .attr('x1','0%').attr('x2','100%').attr('y1','0%').attr('y2','0%');
AXIS_STOPS.forEach(([t]) =>
  _axisGrad.append('stop').attr('offset', `${(t * 100).toFixed(1)}%`).attr('stop-color', axisColor(t))
);

// Vertical gradient for y-axis bar (low relevance → your interests)
// arXiv gold fades in toward the top (high-relevance end).
const _axisYGrad = defs.append('linearGradient').attr('id','axis-y-grad')
  .attr('x1','0%').attr('x2','0%').attr('y1','100%').attr('y2','0%');
_axisYGrad.append('stop').attr('offset','0%').attr('stop-color','rgba(196,148,40,0.0)');
_axisYGrad.append('stop').attr('offset','100%').attr('stop-color','rgba(196,148,40,0.55)');

const BLOB_FILL_DIM  = 0.00,  BLOB_FILL_BASE  = 0.04,  BLOB_FILL_HI  = 0.40;
const BLOB_STRK_DIM  = 0.03,  BLOB_STRK_BASE  = 0.18,  BLOB_STRK_HI  = 1.00;

// Prestige opacity — module-level so click handlers outside renderPapers can use it
// null = not yet verified → treated as ★ until HTML scan runs
// 1    = ★  Open       (unknown or lesser-known affiliation)
// 2    = ★★ Elite      (strong university, national lab, major research institute)
// 3    = ★★★ Frontier  (frontier AI lab or high-mandate research agency)
const PRESTIGE_OPACITY = { 1: 0.42, 2: 0.85, 3: 1.00 };
const dotOpacity = d => PRESTIGE_OPACITY[d.prestige ?? 1];


function starGlowOpacity(dd) {
  if (!dd.starred) return 0;
  if (!paperIsVisible(dd)) return 0;
  if (pinned)       return dd === pinned      ? 0.80 : 0.05;
  if (_hoveredDot)  return dd === _hoveredDot ? 0.80 : 0.20;
  if (_sbHoveredId) {
    const hov = PAPERS.find(p => p.id === _sbHoveredId);
    if (hov) return dd === hov ? 0.80 : 0.20;
  }
  return 0.80;
}

const SCALE = 3;
let currentK = 1 / SCALE;
const zoom = d3.zoom().scaleExtent([1 / SCALE, 12])
  // Allow wheel scroll and pinch-zoom only; block mouse drag so the cursor
  // never switches to a grab hand.
  .filter(e => e.type === 'wheel' || e.type === 'touchstart' || e.type === 'touchmove' || e.type === 'touchend')
  .on('zoom', ev => {
    rootG.attr('transform', ev.transform);
    currentK = ev.transform.k;
    dotsG.selectAll('path.pdot')
      .attr('transform', d => 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(1/currentK)+')');
    dotsG.selectAll('circle.phit')
      .attr('transform', d => 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(1/currentK)+')');
    dotsG.selectAll('path.star-glow')
      .attr('transform', d => 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(1/currentK)+')');
    // Update dim overlays on gradient bar — the in-viewport band stays bright,
    // out-of-viewport portions are covered with a dark overlay.
    if (xSc) {
      const t = ev.transform;
      const W = chartEl.clientWidth;
      const barW = W - M.left - M.right;
      const dom = xSc.domain();
      const span = dom[1] - dom[0];
      const dL = Math.max(0, Math.min(1, (xSc.invert((0 - t.x) / t.k) - dom[0]) / span));
      const dR = Math.max(0, Math.min(1, (xSc.invert((W - t.x) / t.k) - dom[0]) / span));
      axisG.select('.vp-dim-left')
        .attr('x', M.left)
        .attr('width', Math.max(0, dL * barW));
      axisG.select('.vp-dim-right')
        .attr('x', M.left + dR * barW)
        .attr('width', Math.max(0, (1 - dR) * barW));
    }
  });
svg.call(zoom);

// Double-click anywhere on the chart to reset to default view
svg.on('dblclick', () => {
  svg.transition().duration(350).call(zoom.transform, d3.zoomIdentity.scale(1 / SCALE));
});

// ═══════════════════════════════════════════════════════
// DOT SIZING — module-scope so verifyPrestige can update dots after draw() returns
// ═══════════════════════════════════════════════════════
// Tier 3 (elite): 1.5× area → √1.5 ≈ 1.22× radius
// Tier 2 (academic): 1× (default)
// Tier 1 (independent): 0.5× area → √0.5 ≈ 0.71× radius
const SYM_BASE     = 310;
const HIT_BASE     = 18;
const PRESTIGE_AREA = { 1: 0.50, 2: 1.00, 3: 1.50 };
const symSize = d => SYM_BASE * (PRESTIGE_AREA[d.prestige ?? 1] ?? 1.0);
const hitR    = d => HIT_BASE * Math.sqrt(PRESTIGE_AREA[d.prestige ?? 1] ?? 1.0);

// ═══════════════════════════════════════════════════════
// TOOLTIP
// ═══════════════════════════════════════════════════════
const tipEl = document.getElementById('tooltip');
let pinned  = null;
let lastTipEvt = null;

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Tooltip actions via event delegation (no inline onclick — MV3 CSP blocks those) ──
let _tipPaper = null; // currently shown paper, for delegation

tipEl.addEventListener('click', e => {
  if (!_tipPaper) return;
  const p = _tipPaper;
  const el = e.target.closest('[data-tip-action]');
  if (!el) return;
  e.stopPropagation();
  const action = el.dataset.tipAction;

  if (action === 'toggleCat') {
    const cat = el.dataset.cat;
    activeCats.has(cat) ? activeCats.delete(cat) : activeCats.add(cat);
    const btn = document.querySelector('[data-cat="'+cat+'"]');
    if (btn) btn.classList.toggle('active', activeCats.has(cat));
    updateVisibility();
    showTip(lastTipEvt, p);
  } else if (action === 'toggleFmt') {
    const fmt = el.dataset.fmt;
    activeFormats.has(fmt) ? activeFormats.delete(fmt) : activeFormats.add(fmt);
    const btn = document.querySelector('[data-format="'+fmt+'"]');
    if (btn) btn.classList.toggle('active', activeFormats.has(fmt));
    updateVisibility();
    showTip(lastTipEvt, p);
  } else if (action === 'togglePrestige') {
    const tier = parseInt(el.dataset.tier);
    activePrestige.has(tier) ? activePrestige.delete(tier) : activePrestige.add(tier);
    const btn = document.querySelector('[data-prestige="'+tier+'"]');
    if (btn) btn.classList.toggle('active', activePrestige.has(tier));
    updateVisibility();
    showTip(lastTipEvt, p);
  } else if (action === 'toggleCluster') {
    const name = el.dataset.cluster;
    activeClusters.has(name) ? activeClusters.delete(name) : activeClusters.add(name);
    const btn = document.querySelector('[data-cluster="'+name+'"]');
    if (btn) btn.classList.toggle('active', activeClusters.has(name));
    updateVisibility();
    showTip(lastTipEvt, p);
  } else if (action === 'star') {
    toggleStar(p);
    showTip(lastTipEvt, p);
  }
});

// ── Debounced prestige storage writes ───────────────────────────────────────────────
// Accumulates concurrent auto-verify results and flushes in a single storage write,
// avoiding the read-modify-write race condition from interleaved callbacks.
const _pendingPrestigeSaves = new Map(); // id → tier
let   _prestigeSaveTimer    = null;
function schedulePrestigeSave(id, tier) {
  _pendingPrestigeSaves.set(id, tier);
  clearTimeout(_prestigeSaveTimer);
  _prestigeSaveTimer = setTimeout(() => {
    const updates = new Map(_pendingPrestigeSaves);
    _pendingPrestigeSaves.clear();
    chrome.storage.local.get(['processedPapers'], r => {
      const pp = r.processedPapers || [];
      updates.forEach((t, pid) => {
        const idx = pp.findIndex(p => p.id === pid);
        if (idx !== -1) pp[idx].prestige = t;
        else pp.push({ id: pid, prestige: t });
      });
      chrome.storage.local.set({ processedPapers: pp });
    });
  }, 300);
}

// Patch just the prestige span in a sidebar card — avoids full DOM rebuild and the
// synthetic mouseover events that a full renderSidebar() would trigger.
function patchCardPrestige(d) {
  const card = [...document.querySelectorAll('#sidebar-list .sb-card')].find(c => c.dataset.id === d.id);
  if (!card) return;
  const span = card.querySelector('.sb-prestige');
  if (!span) return;
  const presColor = PRESTIGE_COLOR[d.prestige ?? 1];
  const presLabel = PRESTIGE_LABEL_R[d.prestige ?? 1];
  span.style.color = presColor;
  span.textContent = presLabel;
  span.style.pointerEvents = '';
  span.style.cursor = '';
  delete span.dataset.sbAction;
}

// In-flight guard — prevents double-verifying the same paper (e.g. user click + auto-verify race).
const _verifyingIds = new Set();

// Fetch HTML affiliations for a paper and update prestige in place.
// Called on auto-verify (load), dot click, and when user clicks "Unverified ?".
// Always trusts a successful HTML fetch result (allows corrections in both directions).
// Only guard: tier==null means fetch failed — don't touch prestige in that case.
// userInitiated: when true, enforces an 800ms min display of "↻ Verifying…" and shows
// "✗ No data" briefly if the fetch can't determine a tier. Auto-verify passes false
// to avoid slowing down the queue or cluttering the sidebar with "✗ No data" messages.
function verifyPrestige(d, userInitiated = false) {
  if (_verifyingIds.has(d.id)) {
    // Already in flight — sync hover panel state so user sees "↻ Verifying…" instead of "★ Unverified"
    if (_tipPaper === d) showTip(lastTipEvt, d);
    return;
  }
  _verifyingIds.add(d.id);

  // Immediately show "↻ Verifying…" in whichever panels are currently visible.
  const sbCard = [...document.querySelectorAll('#sidebar-list .sb-card')].find(c => c.dataset.id === d.id);
  const sbPres = sbCard?.querySelector('.sb-prestige');
  if (sbPres) { sbPres.textContent = '↻ Verifying…'; sbPres.style.pointerEvents = 'none'; }
  if (_tipPaper === d) {
    const tipPres = tipEl.querySelector('[data-tip-action="togglePrestige"]');
    if (tipPres) { tipPres.textContent = '↻ Verifying…'; tipPres.style.pointerEvents = 'none'; }
  }

  const _verifyStart = Date.now();
  chrome.runtime.sendMessage({ action: 'fetchHTMLPrestige', arxivId: d.id }, resp => {
    _verifyingIds.delete(d.id);
    const tier = resp?.tier;
    const elapsed = Date.now() - _verifyStart;
    // For user-initiated verify, enforce 800ms min so "↻ Verifying…" is readable
    const delay = userInitiated ? Math.max(0, 800 - elapsed) : 0;

    if (tier == null || tier === d.prestige) {
      setTimeout(() => {
        // For user-initiated null result: flash "✗ No data" so they know we tried
        if (userInitiated && tier == null && d.prestige === null) {
          const sbCard2 = [...document.querySelectorAll('#sidebar-list .sb-card')].find(c => c.dataset.id === d.id);
          const sbPres2 = sbCard2?.querySelector('.sb-prestige');
          if (sbPres2) { sbPres2.textContent = '✗ No data'; sbPres2.style.pointerEvents = 'none'; }
          if (_tipPaper === d) {
            const tp = tipEl.querySelector('[data-tip-action="togglePrestige"]');
            if (tp) { tp.textContent = '✗ No data'; tp.style.pointerEvents = 'none'; }
          }
          setTimeout(() => { patchCardPrestige(d); if (_tipPaper === d) showTip(lastTipEvt, d); }, 1200);
        } else {
          patchCardPrestige(d);
          if (_tipPaper === d) showTip(lastTipEvt, d);
        }
      }, delay);
      return;
    }
    // Prestige changed — update data, dots, filter bar, and both panels.
    setTimeout(() => {
      d.prestige = tier;
      dotsG.selectAll('path.pdot').filter(dd => dd === d)
        .attr('d', d3.symbol().type(D3_SYMBOL[d.format] || d3.symbolCircle).size(symSize(d))());
      dotsG.selectAll('circle.phit').filter(dd => dd === d).attr('r', hitR(d));
      // star-glow is fixed size — no update needed when prestige changes
      patchCardPrestige(d);
      if (_tipPaper === d) showTip(lastTipEvt, d);
      updateVisibility();
      schedulePrestigeSave(d.id, tier);
    }, delay);
  });
}

function showTip(evt, p) {
  _tipPaper = p;
  const clusterChips = p.clusters.map(c => {
    const active = !activeClusters.size || activeClusters.has(c);
    return '<span class="tt-cluster-chip active-chip" data-tip-action="toggleCluster" data-cluster="'+esc(c)+'" style="cursor:pointer;opacity:'+(active?'1':'0.38')+'">'+esc(c)+'</span>';
  }).join(' ');
  const catActive  = !activeCats.size    || activeCats.has(p.cat);
  const fmtActive  = !activeFormats.size || activeFormats.has(p.format);
  const tier       = p.prestige ?? 1;
  const tierActive = !activePrestige.size || activePrestige.has(tier);
  const isVerifying = _verifyingIds.has(p.id);
  const prestigeText = isVerifying ? '↻ Verifying…' : PRESTIGE_LABEL_R[tier];
  const badgeStyle = (color, active) =>
    'color:'+color+';border-color:'+color+';cursor:pointer;opacity:'+(active?'1':'0.38')+';';
  tipEl.innerHTML =
    // Top row: tags left, rating right — mirrors text pane layout
    '<div class="tt-header-row">'+
      '<span>'+
        '<span data-tip-action="toggleCat" data-cat="'+p.cat+'" style="color:'+(CAT_COLOR[p.cat]||'#94A3B8')+';opacity:'+(catActive?'1':'0.38')+';cursor:pointer">'+(CAT_LABEL[p.cat]||p.cat)+'</span>'+
        (FMT_LABEL[p.format] ? '<span class="tt-header-sep">·</span><span data-tip-action="toggleFmt" data-fmt="'+p.format+'" style="color:'+FMT_COLOR[p.format]+';opacity:'+(fmtActive?'1':'0.38')+';cursor:pointer">'+FMT_LABEL[p.format]+'</span>' : '')+
      '</span>'+
      '<span data-tip-action="togglePrestige" data-tier="'+tier+'" style="color:'+PRESTIGE_COLOR[tier]+';opacity:'+(tierActive?'1':'0.38')+';cursor:pointer'+(isVerifying?';pointer-events:none':'')+'">'+ prestigeText+'</span>'+
    '</div>'+
    '<div class="tt-title">'+esc(p.title)+'</div>'+
    '<div class="tt-clusters">'+clusterChips+'</div>'+
    (function(){
      const { excerpt } = extractExcerpt(p._summary || p.gist || '');
      return '<div class="tt-gist" style="color:rgba(232,217,188,0.82)">'+esc(excerpt)+'</div>';
    })()+
    '<div class="tt-authors"><a href="'+esc(p._absLink)+'" target="_blank" style="color:rgba(241,240,222,0.35);text-decoration:underline">arxiv:'+esc(p.id)+' \u2197</a></div>'+
    '<a class="tt-pdf-btn" href="'+esc(p._pdfLink||'https://arxiv.org/pdf/'+p.id)+'" target="_blank">\ud83d\udcc4 Open this PDF</a>'+
    '<button class="tt-star-btn '+(p.starred?'starred':'')+'" data-tip-action="star">'+
      (p.starred ? '\u2605 Starred \u2014 click to unstar' : '\u2606 Star this paper')+
    '</button>'+
    '<div class="tt-hint" style="margin-top:6px">'+(pinned===p?'click anywhere to unpin':'click to pin \u00b7 tags filter papers')+'</div>';
  lastTipEvt = evt;
  tipEl.style.pointerEvents = (pinned === p) ? 'auto' : 'none';
  tipEl.style.display = 'block';
  moveTip(evt);
}

function moveTip(evt) {
  const pad=14, tw=tipEl.offsetWidth, th=tipEl.offsetHeight;
  const sbEl = document.getElementById('sidebar');
  const chartRight = (sbEl && !sbEl.classList.contains('collapsed'))
    ? sbEl.getBoundingClientRect().left - 8
    : window.innerWidth - 8;
  let lx = evt.clientX-tw-pad, ly = evt.clientY-th-pad; // default: entirely above reference point
  if (lx < 8) lx = Math.min(evt.clientX+pad, chartRight-tw); // right fallback, capped at sidebar
  if (lx+tw > chartRight) lx = chartRight-tw;                // hard clamp right edge
  if (lx < 8) lx = 8;
  if (ly < 8) ly = evt.clientY+pad;                          // can't go above → flip below
  if (ly+th > window.innerHeight-8) ly = window.innerHeight-th-8; // clamp if below goes off screen
  if (ly < 8) ly = 8;
  tipEl.style.left = lx+'px'; tipEl.style.top = ly+'px';
}

document.addEventListener('click', e => {
  if (!e.target.closest('#tooltip') && !e.target.closest('.phit') && !e.target.closest('.sb-card')) {
    pinned = null; _sbHoveredId = null; tipEl.style.display = 'none';
    dotsG?.selectAll('path.pdot').attr('fill', dd => dotColor(dd)).attr('fill-opacity', dd => dotOpacity(dd)).attr('stroke-opacity', dd => dotOpacity(dd) * 0.7).style('filter', null);
    dotsG?.selectAll('path.star-glow').attr('opacity', dd => starGlowOpacity(dd)).attr('stroke', '#C49428');
    resetClusterHighlight();
    document.querySelectorAll('.sb-card.sb-active').forEach(c => c.classList.remove('sb-active'));
  }
});

// ═══════════════════════════════════════════════════════
// CLUSTER HIGHLIGHT
// ═══════════════════════════════════════════════════════
const clusterBarEl = document.getElementById('cluster-bar');

function highlightClusters(activePaperClusters, paper = null) {
  const active = new Set(activePaperClusters);
  blobsG.selectAll('.blob-fill')
    .attr('opacity', d => active.has(d.cluster) ? BLOB_FILL_HI : BLOB_FILL_DIM)
    .attr('filter', d => active.has(d.cluster) ? 'url(#blob-glow)' : 'url(#blob-blur)');
  blobsG.selectAll('.blob-stroke')
    .attr('opacity', d => active.has(d.cluster) ? BLOB_STRK_HI : BLOB_STRK_DIM)
    .attr('stroke-width', d => active.has(d.cluster) ? 4 : 3);
  clusterBarEl.querySelectorAll('.cluster-btn').forEach(btn =>
    btn.classList.toggle('lit', active.has(btn.dataset.cluster)));
  clusterNameEl.textContent = [...active].join(' \u00b7 ');
  clusterNameEl.style.opacity = 1;
  document.querySelectorAll('[data-cat]').forEach(btn =>
    btn.classList.toggle('lit', paper?.cat === btn.dataset.cat));
  document.querySelectorAll('[data-format]').forEach(btn =>
    btn.classList.toggle('lit', paper?.format === btn.dataset.format));
  document.querySelectorAll('[data-prestige]').forEach(btn =>
    btn.classList.toggle('lit', String(paper?.prestige ?? 1) === btn.dataset.prestige));
  document.getElementById('star-filter-btn')
    ?.classList.toggle('lit', !!paper?.starred);
  const spotlit = paper !== null;
  clusterBarEl.classList.toggle('spotlight-active', spotlit);
  document.getElementById('legend')?.classList.toggle('spotlight-active', spotlit);
  // Light up all tags on the specific paper's sidebar card
  document.querySelectorAll('.sb-card .sb-tag.lit, .sb-card .sb-cluster-chip.lit')
    .forEach(b => b.classList.remove('lit'));
  if (paper) {
    const sbCard = document.querySelector('.sb-card[data-id="'+paper.id+'"]');
    if (sbCard) sbCard.querySelectorAll('.sb-tag, .sb-cluster-chip')
      .forEach(b => b.classList.add('lit'));
  }
}

function resetClusterHighlight() {
  blobsG.selectAll('.blob-fill')
    .attr('opacity', d => clusterHasVisiblePaper(d.cluster) ? BLOB_FILL_BASE : BLOB_FILL_DIM)
    .attr('filter', 'url(#blob-blur)');
  blobsG.selectAll('.blob-stroke')
    .attr('opacity', d => clusterHasVisiblePaper(d.cluster) ? BLOB_STRK_BASE : BLOB_STRK_DIM)
    .attr('stroke-width', 3);
  clusterNameEl.style.opacity = 0;
  document.querySelectorAll('[data-cat],[data-format],[data-prestige]')
    .forEach(btn => btn.classList.remove('lit'));
  document.getElementById('star-filter-btn')?.classList.remove('lit');
  clusterBarEl.querySelectorAll('.cluster-btn').forEach(btn => btn.classList.remove('lit'));
  document.querySelectorAll('.sb-card .sb-tag, .sb-card .sb-cluster-chip')
    .forEach(b => b.classList.remove('lit'));
  clusterBarEl.classList.remove('spotlight-active');
  document.getElementById('legend')?.classList.remove('spotlight-active');
}

function matchesSearch(d) {
  if (!searchQuery) return true;
  const q = searchQuery;
  return d.title.toLowerCase().includes(q)
    || (d.gist     || '').includes(q)
    || (d._authors || '').toLowerCase().includes(q);
}

function paperIsVisible(d) {
  return (!activeCats.size    || activeCats.has(d.cat))
    && (!activeFormats.size  || activeFormats.has(d.format))
    && (!activePrestige.size || activePrestige.has(d.prestige ?? 1))
    && (!activeClusters.size || d.clusters.some(c => activeClusters.has(c)))
    && (!starFilterActive || d.starred)
    && matchesSearch(d);
}

function clusterHasVisiblePaper(clusterName) {
  if (activeClusters.size && !activeClusters.has(clusterName)) return false;
  return PAPERS.some(p => p.clusters.includes(clusterName) && paperIsVisible(p));
}

// ═══════════════════════════════════════════════════════
// VISIBILITY & FILTERS
// ═══════════════════════════════════════════════════════
function updateVisibility() {
  // Collect visible papers in one pass
  const visiblePapers = PAPERS.filter(p => paperIsVisible(p));
  const visibleIds = new Set(visiblePapers.map(p => p.id));

  dotsG.selectAll('.phit').attr('pointer-events', d => visibleIds.has(d.id) ? 'all' : 'none');
  // Star ring only shows when the paper itself is visible
  dotsG.selectAll('path.star-glow').attr('opacity', d => visibleIds.has(d.id) ? starGlowOpacity(d) : 0);

  // If a spotlight is active (hover or pin), don't stomp fill-opacity — just hide invisible papers.
  const spotlitPaper = pinned || (_sbHoveredId ? PAPERS.find(p => p.id === _sbHoveredId) : null) || _hoveredDot;
  if (spotlitPaper) {
    dotsG.selectAll('path.pdot').attr('opacity', d => visibleIds.has(d.id) ? null : 0.05);
  } else {
    dotsG.selectAll('path.pdot').attr('opacity', d => visibleIds.has(d.id) ? 0.88 : 0.05);
  }

  const countEl = document.getElementById('vis-count');
  if (countEl) countEl.textContent = visiblePapers.length;

  // Update legend button counts and dim any that reach 0
  document.querySelectorAll('[data-cat]').forEach(btn => {
    const n = visiblePapers.filter(p => p.cat === btn.dataset.cat).length;
    const span = btn.querySelector('.fb-count');
    if (span) span.textContent = n;
    btn.classList.toggle('zero-count', n === 0);
  });
  document.querySelectorAll('[data-format]').forEach(btn => {
    const n = visiblePapers.filter(p => p.format === btn.dataset.format).length;
    const span = btn.querySelector('.fb-count');
    if (span) span.textContent = n;
    btn.classList.toggle('zero-count', n === 0);
  });
  document.querySelectorAll('[data-prestige]').forEach(btn => {
    const tier = parseInt(btn.dataset.prestige);
    const n = visiblePapers.filter(p => (p.prestige ?? 1) === tier).length;
    const span = btn.querySelector('.fb-count');
    if (span) span.textContent = n;
    btn.classList.toggle('zero-count', n === 0);
  });
  document.querySelectorAll('[data-cluster]').forEach(btn => {
    if (btn.closest('#tooltip')) return; // skip tooltip cluster chips
    const n = visiblePapers.filter(p => p.clusters.includes(btn.dataset.cluster)).length;
    // sidebar cluster buttons have .fb-count; top bar buttons have .cb-count
    const span = btn.querySelector('.fb-count') || btn.querySelector('.cb-count');
    if (span) span.textContent = n;
    btn.classList.toggle('zero-count', n === 0);
  });

  const spotlitPaper2 = pinned || (_sbHoveredId ? PAPERS.find(p => p.id === _sbHoveredId) : null) || _hoveredDot;
  if (!spotlitPaper2) {
    if (activeClusters.size) highlightClusters([...activeClusters]);
    else resetClusterHighlight();
  }

  renderSidebar();
}

// ═══════════════════════════════════════════════════════
// SIDEBAR — ranked paper list
// ═══════════════════════════════════════════════════════

// Find the index of the last *real* sentence boundary (period/!/?) in `text`,
// skipping false positives from abbreviations like "vs.", "e.g.", "et al." and
// single lowercase letters.  Returns the index of the punctuation char, or -1.
// The next sentence starts at returnValue + 2.
function lastRealSentenceBound(text) {
  // Abbreviations whose trailing period must not be treated as a sentence end
  const ABBREV_RE = /\b(?:vs|e\.g|i\.e|et\s+al|fig|eq|refs?|sec|no|vol|pp|ca|cf|viz|approx|dept|univ|dr|mr|mrs|ms|prof|sr|jr|[a-z])\s*$/i;
  let best = -1;
  const re = /([.!?;])([ \n])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] === '.') {
      // Skip if preceded by a known abbreviation
      if (ABBREV_RE.test(text.slice(0, m.index))) continue;
      // Skip if the next non-space character is lowercase (not a sentence start)
      const after = text.slice(m.index + 2);
      if (after && /^[a-z]/.test(after)) continue;
    }
    best = m.index;
  }
  return best;
}

// Extract the highlight excerpt from an abstract: the gap sentence (the one
// immediately before "We introduce/propose/present/…") plus the contribution
// sentence itself.  Returns { before, excerpt, after } for three-way rendering.
// Falls back to first ~200 chars if no contribution sentence is found.
function extractExcerpt(text) {
  if (!text) return { before: '', gap: '', excerpt: text || '', after: '' };

  const CONTRIB_RE = /\b(?:We|This\s+(?:paper|work|article|study))\s+(introduce[sd]?|present[s]?|propose[sd]?|develop[s]?|show[s]?|release[sd]?|train[s]?|build[s]?|design[s]?|describe[sd]?|demonstrate[sd]?|report[s]?|find[s]?|found|identif(?:y|ies|ied)|establish(?:es|ed)?|evaluate[sd]?|analy[zs]e[sd]?|investigat(?:e[sd]?|es)|examin(?:e[sd]?|es)|explor(?:e[sd]?|es)|stud(?:y|ies|ied)|survey[sd]?|test[s]?|extend[s]?|contribut(?:e[sd]?|es)|address(?:es|ed)?|focus(?:es|ed)?|quantif(?:y|ies|ied))\b/i;

  // Collect all matches; prefer the first whose sentence contains "(1)" (enumerated contributions)
  const allMatches = [];
  const reG = new RegExp(CONTRIB_RE.source, 'gi');
  let _m;
  while ((_m = reG.exec(text)) !== null) allMatches.push(_m);

  if (!allMatches.length) {
    // Fallback: highlight the first complete sentence in gold, next sentence in white
    const sentM = /[.!?](?:\s|$)/.exec(text);
    const split = sentM ? sentM.index + 1 : Math.min(200, text.length);
    const afterText = text.slice(split);
    const afterSentM = /[.!?](?:\s|$)/.exec(afterText);
    const afterGapEnd = afterSentM ? split + afterSentM.index + 1 : split;
    return { before: '', gap: '', excerpt: text.slice(0, split),
             afterGap: text.slice(split, afterGapEnd), after: text.slice(afterGapEnd) };
  }

  // Prefer first match whose sentence contains "(1)" — enumerated-contribution sentences
  let chosen = allMatches[0];
  for (const candidate of allMatches) {
    const bef = text.slice(0, candidate.index);
    const sStart = Math.max(bef.lastIndexOf('. ') + 2, bef.lastIndexOf('.\n') + 2, 0);
    const tl = text.slice(candidate.index);
    const eM = /[.!?](?:\s|$)/.exec(tl);
    const sEnd = eM ? candidate.index + eM.index + 1 : text.length;
    if (/\(1\)/.test(text.slice(sStart, sEnd))) { chosen = candidate; break; }
  }

  // Find the start of the contribution sentence (the one beginning with "We …")
  // Use lastRealSentenceBound to skip abbreviation periods like "vs.", "e.g."
  const beforeContrib = text.slice(0, chosen.index);
  const contribBoundary = lastRealSentenceBound(beforeContrib);
  const contribStart = contribBoundary === -1 ? 0 : contribBoundary + 2;

  // Find the end of the contribution sentence. Stop at first sentence boundary (including
  // semicolons — long enumerated lists are cut short in favour of readability), capped at 350 chars.
  const tail = text.slice(chosen.index);
  const endM = /[.!?;](?:\s|$)/.exec(tail);
  const rawEnd = endM ? chosen.index + endM.index + 1 : text.length;
  const excerptEnd = Math.min(rawEnd, chosen.index + 350);

  // Find the start of the gap sentence (the sentence immediately before contrib)
  if (contribStart === 0) {
    // Contribution is the very first sentence — show one white sentence after it instead of before
    const afterText = text.slice(excerptEnd);
    const afterSentM = /[.!?](?:\s|$)/.exec(afterText);
    const afterGapEnd = afterSentM ? excerptEnd + afterSentM.index + 1 : text.length;
    return { before: '', gap: '', excerpt: text.slice(0, excerptEnd),
             afterGap: text.slice(excerptEnd, afterGapEnd), after: text.slice(afterGapEnd) };
  }
  const beforeGap = text.slice(0, contribBoundary); // text before the gap sentence's terminal '.'
  const gapBoundary = lastRealSentenceBound(beforeGap);
  const gapStart = gapBoundary === -1 ? 0 : gapBoundary + 2;

  return {
    before:  text.slice(0, gapStart),
    gap:     text.slice(gapStart, contribStart),   // white  — sentence before "We …"
    excerpt: text.slice(contribStart, excerptEnd), // gold   — "We introduce/propose/…" sentence
    after:   text.slice(excerptEnd),
  };
}

let _sidebarWired = false;

function renderSidebar() {
  const listEl = document.getElementById('sidebar-list');
  const titleEl = document.getElementById('sidebar-title');
  if (!listEl) return;

  const personalized = Object.keys(_starredData).length > 0;
  if (titleEl) titleEl.textContent = personalized ? 'For you' : 'Relevant today';

  // Score and sort visible papers by projected interest (descending), top 60
  let entries = PAPERS
    .filter(p => paperIsVisible(p))
    .map(p => ({ p, score: scoreAffinity(p, _starredData) ?? p.relevance }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 60);

  // Float pinned paper to top if it's outside the top 60 (so scrollToCard always finds it)
  if (pinned && !entries.some(e => e.p.id === pinned.id)) {
    entries = [{ p: pinned, score: Infinity }, ...entries.slice(0, 59)];
  }

  listEl.innerHTML = entries.map(({ p }) => {
    const presColor  = PRESTIGE_COLOR[p.prestige ?? 1];
    const presLabel  = PRESTIGE_LABEL_R[p.prestige ?? 1];
    const pdfHref    = esc(p._pdfLink || 'https://arxiv.org/pdf/'+p.id);
    const catActive  = activeCats.has(p.cat);
    const fmtActive  = activeFormats.has(p.format);
    const tier       = p.prestige ?? 1;
    const tierActive = activePrestige.has(tier);
    const clusterChipsSb = (p.clusters || []).map(c => {
      const active = activeClusters.has(c);
      return '<button class="sb-cluster-chip'+(active?' active':'')+'" data-sb-action="toggleCluster" data-cluster="'+esc(c)+'" style="color:'+(CLUSTER_COLOR[c]||'rgba(232,217,188,0.6)')+'">'+esc(c)+'</button>';
    }).join('');
    return '<div class="sb-card" data-id="'+esc(p.id)+'">'
      + '<div class="sb-title">'+esc(p.title)+'</div>'
      + '<div class="sb-card-meta">'
      + '<span class="sb-meta-tags">'
      + '<button class="sb-tag'+(catActive?' active':'')+'" data-sb-action="toggleCat" data-cat="'+p.cat+'" style="color:'+(CAT_COLOR[p.cat]||'#94A3B8')+'">'+(CAT_LABEL[p.cat]||p.cat)+'</button>'
      + (FMT_LABEL[p.format] ? '<button class="sb-tag'+(fmtActive?' active':'')+'" data-sb-action="toggleFmt" data-fmt="'+p.format+'" style="color:'+(FMT_COLOR[p.format]||'#94A3B8')+'">'+FMT_LABEL[p.format]+'</button>' : '')
      + '</span>'
      + '<button class="sb-tag'+(tierActive?' active':'')+'" data-sb-action="togglePrestige" data-prestige="'+tier+'" style="color:'+presColor+'">'+presLabel+'</button>'
      + '</div>'
      + (clusterChipsSb ? '<div class="sb-clusters">'+clusterChipsSb+'</div>' : '')
      + (function() {
          const { before, gap, excerpt, afterGap, after } = extractExcerpt(p._summary || p.gist || '');
          return '<div class="sb-gist">'
            + esc(before)
            + (gap ? '<span class="sb-gap">'+esc(gap)+'</span>' : '')
            + '<span class="sb-excerpt">'+esc(excerpt)+'</span>'
            + (afterGap ? '<span class="sb-gap">'+esc(afterGap)+'</span>' : '')
            + esc(after)
            + '</div>';
        })()
      + '<div class="sb-actions">'
      + '<button class="sb-star'+(p.starred?' starred':'')+'" data-sb-action="star">'+(p.starred?'\u2605 Starred':'\u2606 Star')+'</button>'
      + '<a class="sb-pdf" href="'+pdfHref+'" target="_blank" data-sb-action="pdf">\ud83d\udcc4 Open PDF</a>'
      + '</div>'
      + '</div>';
  }).join('');

  // Re-apply .lit to pinned card's tags after re-render
  if (pinned) {
    const sbCard = listEl.querySelector('.sb-card[data-id="'+pinned.id+'"]');
    if (sbCard) sbCard.querySelectorAll('.sb-tag, .sb-cluster-chip')
      .forEach(b => b.classList.add('lit'));
  }

  // Wire event listeners once — the list element itself is stable
  if (!_sidebarWired) {
    listEl.addEventListener('click',     sidebarClick);
    listEl.addEventListener('mouseover',  sidebarMouseover);
    listEl.addEventListener('mouseleave', sidebarMouseout);
    listEl.addEventListener('scroll',    sidebarScroll);
    // Track cursor position passively so scroll handler can re-detect card under cursor
    listEl.addEventListener('mousemove', e => { _sbCursorX = e.clientX; _sbCursorY = e.clientY; });
    _sidebarWired = true;
  }
}

let _sbHoveredId = null;
let _hoveredDot  = null;
let _sbCursorX   = 0;
let _sbCursorY   = 0;

// Apply hover-level spotlight for a sidebar card (dim others to 0.25).
// Used by mouseover and unpin — distinct from pin-level (0.08 dim) in sidebarClick.
function applySidebarSpotlight(d) {
  if (!dotsG) return;
  const hi = highlightColor(d);
  const sameCluster = dd => d.clusters.some(c => dd.clusters.includes(c));
  dotsG.selectAll('path.pdot')
    .attr('fill',           dd => dd === d ? hi : dotColor(dd))
    .attr('fill-opacity',   dd => dd === d ? 1   : sameCluster(dd) ? dotOpacity(dd) : 0.06)
    .attr('stroke-opacity', dd => dd === d ? 0.6 : sameCluster(dd) ? dotOpacity(dd) * 0.7 : 0.02);
  dotsG.selectAll('path.star-glow').attr('opacity', dd => dd.starred ? (dd === d ? 0.80 : 0.20) : 0)
    .attr('stroke', dd => dd === d ? hi : '#C49428');
  highlightClusters(d.clusters, d);
}

// mouseover fires on element-boundary crossings (bubbles from children).
// Ignore events that land in gaps between cards (no .sb-card ancestor).
// Sidebar spotlight is sticky — no reset when cursor leaves the list.
function sidebarMouseover(e) {
  if (pinned) return;
  const card = e.target.closest('.sb-card');
  if (!card) return; // cursor in gap/padding — no change
  const newId = card.dataset.id;
  if (newId === _sbHoveredId) return;
  _sbHoveredId = newId;
  const d = PAPERS.find(p => p.id === newId);
  if (d) applySidebarSpotlight(d);
}

// Reset spotlight when cursor leaves the list entirely (mirrors dot mouseleave on map).
function sidebarMouseout(e) {
  // mouseleave — only fires when pointer physically exits the list, not on DOM mutations
  if (pinned) return;
  _sbHoveredId = null;
  _sidebarSpotlightReset();
}

// When the sidebar scrolls the card under a stationary cursor may change.
// Re-detect the card at the last known cursor position and update spotlight.
function sidebarScroll() {
  if (pinned) return;
  const el = document.elementFromPoint(_sbCursorX, _sbCursorY);
  const card = el?.closest('.sb-card');
  const newId = card?.dataset.id ?? null;
  if (newId === _sbHoveredId) return;
  _sbHoveredId = newId;
  if (newId) {
    const d = PAPERS.find(p => p.id === newId);
    if (d) applySidebarSpotlight(d);
  } else {
    _sidebarSpotlightReset();
  }
}

function _sidebarSpotlightReset() {
  if (pinned) return;
  if (!dotsG) return;
  dotsG.selectAll('path.pdot')
    .attr('fill',           dd => dotColor(dd))
    .attr('fill-opacity',   dd => dotOpacity(dd))
    .attr('stroke-opacity', dd => dotOpacity(dd) * 0.7);
  dotsG.selectAll('path.star-glow').attr('opacity', dd => starGlowOpacity(dd));
  resetClusterHighlight();
}

function sidebarClick(e) {
  const card = e.target.closest('.sb-card');
  if (!card) return;
  const d = PAPERS.find(p => p.id === card.dataset.id);
  if (!d) return;

  // Star / PDF / cluster-filter buttons — handle without pinning
  if (e.target.closest('[data-sb-action="star"]')) { toggleStar(d); return; }
  if (e.target.closest('[data-sb-action="pdf"]')) return;
  if (e.target.closest('[data-sb-action="verify"]')) {
    verifyPrestige(d, true); // userInitiated: enforces 800ms min display + "✗ No data" feedback
    return;
  }
  if (e.target.closest('[data-sb-action="toggleCat"]')) {
    const cat = e.target.closest('[data-sb-action="toggleCat"]').dataset.cat;
    activeCats.has(cat) ? activeCats.delete(cat) : activeCats.add(cat);
    document.querySelectorAll('#legend .filter-btn[data-cat="'+cat+'"]')
      .forEach(b => b.classList.toggle('active', activeCats.has(cat)));
    updateVisibility(); return;
  }
  if (e.target.closest('[data-sb-action="toggleFmt"]')) {
    const fmt = e.target.closest('[data-sb-action="toggleFmt"]').dataset.fmt;
    activeFormats.has(fmt) ? activeFormats.delete(fmt) : activeFormats.add(fmt);
    document.querySelectorAll('#legend .filter-btn[data-format="'+fmt+'"]')
      .forEach(b => b.classList.toggle('active', activeFormats.has(fmt)));
    updateVisibility(); return;
  }
  if (e.target.closest('[data-sb-action="togglePrestige"]')) {
    const tier = parseInt(e.target.closest('[data-sb-action="togglePrestige"]').dataset.prestige);
    activePrestige.has(tier) ? activePrestige.delete(tier) : activePrestige.add(tier);
    document.querySelectorAll('#legend .filter-btn[data-prestige="'+tier+'"]')
      .forEach(b => b.classList.toggle('active', activePrestige.has(tier)));
    updateVisibility(); return;
  }
  if (e.target.closest('[data-sb-action="toggleCluster"]')) {
    const cluster = e.target.closest('[data-sb-action="toggleCluster"]').dataset.cluster;
    activeClusters.has(cluster) ? activeClusters.delete(cluster) : activeClusters.add(cluster);
    document.querySelectorAll('#cluster-bar .cluster-btn[data-cluster="'+cluster+'"]')
      .forEach(b => b.classList.toggle('active', activeClusters.has(cluster)));
    updateVisibility(); return;
  }

  // Remove active highlight from all cards
  document.querySelectorAll('.sb-card.sb-active').forEach(c => c.classList.remove('sb-active'));

  if (pinned === d) {
    // Unpin: restore hover spotlight for last-hovered card (sticky), or full reset
    pinned = null;
    tipEl.style.display = 'none';
    const hovered = _sbHoveredId ? PAPERS.find(p => p.id === _sbHoveredId) : null;
    if (hovered) {
      applySidebarSpotlight(hovered);
    } else {
      _sidebarSpotlightReset();
    }
  } else {
    pinned = d;
    card.classList.add('sb-active');
    const hi = highlightColor(d);
    const sameCluster = dd => d.clusters.some(c => dd.clusters.includes(c));
    dotsG.selectAll('path.pdot')
      .attr('fill',           dd => dd === d ? hi : dotColor(dd))
      .attr('fill-opacity',   dd => dd === d ? 1   : sameCluster(dd) ? dotOpacity(dd) : 0.06)
      .attr('stroke-opacity', dd => dd === d ? 0.6 : sameCluster(dd) ? dotOpacity(dd) * 0.7 : 0.02)
      .style('filter', null)
      .filter(dd => dd === d).raise();
    dotsG.selectAll('path.star-glow').attr('opacity', dd => dd.starred ? (dd === d ? 0.80 : 0.05) : 0)
      .attr('stroke', dd => dd === d ? hi : '#C49428');
    highlightClusters(d.clusters, d);
    // Position tooltip at the dot's actual screen position (accounting for zoom/pan)
    const svgRect = document.getElementById('chart').getBoundingClientRect();
    const t = d3.zoomTransform(svg.node());
    const dotScreenX = svgRect.left + t.applyX(xSc(d._x));
    const dotScreenY = svgRect.top  + t.applyY(ySc(d._y));
    showTip({ clientX: dotScreenX, clientY: dotScreenY }, d);
  }
}

// ═══════════════════════════════════════════════════════
// JITTER & POSITIONING
// ═══════════════════════════════════════════════════════
function seededRand(seed) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function applyJitter() {
  const JITTER_X = 0.12;
  const starCount = Object.keys(_starredData || {}).length;
  const JITTER_Y = 0.09 * Math.exp(-starCount / 8);  // decays toward 0 as you star more papers
  const isPersonalized = starCount > 0;

  // Even-spread X jitter within each score bucket: rank papers sharing the same
  // discrete score and distribute them evenly across the jitter band so columns
  // don't form. Uses seeded RNG for stable ordering across reloads.
  const buckets = {};
  PAPERS.forEach(p => {
    const key = p.applied.toFixed(2);
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(p);
  });
  Object.values(buckets).forEach(group => {
    // Shuffle group deterministically using each paper's own seed
    group.sort((a, b) => {
      const ra = seededRand(parseInt(a.id.replace('.','')) || 12345)();
      const rb = seededRand(parseInt(b.id.replace('.','')) || 12345)();
      return ra - rb;
    });
    const n = group.length;
    group.forEach((p, i) => {
      // Spread evenly from -JITTER_X to +JITTER_X within the bucket
      const offset = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * JITTER_X;
        p._x = p.applied + offset; // no clamp — jitter can extend past 0/1 boundaries
    });
  });

  // Normalize _x to the actual scale domain so dot color matches the axis bar gradient.
  // The bar gradient spans [0,1] across [min(_x)-PAD, max(_x)+PAD], so a paper at _x=0
  // sits at ~PAD/range, not 0 — _colorT captures that fraction for consistent coloring.
  const PAD = 0.08;
  const allX = PAPERS.map(p => p._x);
  const xMin = Math.min(...allX) - PAD, xMax = Math.max(...allX) + PAD;
  PAPERS.forEach(p => { p._colorT = (p._x - xMin) / (xMax - xMin); });

  PAPERS.forEach(p => {
    const rng  = seededRand(parseInt(p.id.replace('.','')) || 12345);
    rng(); // consume first value (used for bucket sort above)
    const yBase = isPersonalized
      ? (scoreAffinity(p, _starredData) ?? p.relevance)
      : p.relevance;
    p._y = yBase + (rng() - 0.5) * 2 * JITTER_Y; // no clamp — matches x jitter behavior
  });
}

// Smoothly move existing dots to their new _x/_y positions (called after
// applyJitter when stars change — avoids full redraw).
function animateDots() {
  if (!xSc || !ySc) return;
  const dur = 700;
  dotsG.selectAll('path.pdot').transition().duration(dur).ease(d3.easeCubicInOut)
    .attr('transform', d => 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(1/currentK)+')');
  dotsG.selectAll('circle.phit').transition().duration(dur).ease(d3.easeCubicInOut)
    .attr('transform', d => 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(1/currentK)+')');
  dotsG.selectAll('path.star-glow').transition().duration(dur).ease(d3.easeCubicInOut)
    .attr('transform', d => 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(1/currentK)+')');
}

// ═══════════════════════════════════════════════════════
// DRAW
// ═══════════════════════════════════════════════════════
let xSc, ySc;

function drawBlobs() {
  blobsG.selectAll('*').remove();
  ALL_CLUSTERS.forEach(name => {
    const members = PAPERS.filter(p => p.clusters.includes(name));
    if (members.length < 2) return;
    const pts = members.map(p => [xSc(p._x), ySc(p._y)]);
    const cx  = d3.mean(pts, d=>d[0]);
    const cy  = d3.mean(pts, d=>d[1]);
    const color = '#9BAAB8'; // neutral blue-grey — blobs show grouping, not score
    let pathStr = null;
    if (pts.length >= 3) {
      const hull = d3.polygonHull(pts);
      if (hull) {
        const inflated = hull.map(pt => {
          const dx=pt[0]-cx, dy=pt[1]-cy, len=Math.hypot(dx,dy)||1;
          return [pt[0]+dx/len*90, pt[1]+dy/len*90];
        });
        pathStr = d3.line().x(d=>d[0]).y(d=>d[1]).curve(d3.curveCatmullRomClosed)(inflated);
      }
    }
    if (!pathStr) {
      const rx = Math.max(80, (d3.deviation(pts,d=>d[0])||80)*2.0);
      const ry = Math.max(80, (d3.deviation(pts,d=>d[1])||80)*2.0);
      pathStr = 'M'+(cx-rx)+','+cy+' A'+rx+','+ry+',0,1,0,'+(cx+rx)+','+cy+' A'+rx+','+ry+',0,1,0,'+(cx-rx)+','+cy+'Z';
    }
    blobsG.append('path').datum({cluster:name})
      .attr('class','blob-fill').attr('d',pathStr)
      .attr('fill',color).attr('opacity',BLOB_FILL_BASE).attr('filter','url(#blob-blur)')
      .attr('pointer-events','none');
    blobsG.append('path').datum({cluster:name})
      .attr('class','blob-stroke').attr('d',pathStr)
      .attr('fill','none').attr('stroke',color).attr('opacity',BLOB_STRK_BASE).attr('stroke-width',3)
      .attr('pointer-events','none');
  });
}

function drawDots() {
  dotsG.selectAll('*').remove();

  function symTransform(d, scl) {
    return 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(scl/currentK)+')';
  }

  const drawKey = d => (d.starred ? 100 : 0) + (d.prestige ?? 1) * 10 + (d.applied ?? 0.5);
  const sorted  = [...PAPERS].sort((a, b) => drawKey(a) - drawKey(b));

  dotsG.selectAll('path.pdot').data(sorted).join('path').attr('class','pdot')
    .attr('d', d => d3.symbol().type(D3_SYMBOL[d.format] || d3.symbolCircle).size(symSize(d))())
    .attr('transform', d => symTransform(d, 1))
    .attr('fill', d => dotColor(d)).attr('fill-opacity', d => dotOpacity(d))
    .attr('stroke', d => dotColor(d)).attr('stroke-width', 0.8).attr('stroke-opacity', d => dotOpacity(d) * 0.7)
    .attr('pointer-events', 'none');

  // Star glows render AFTER dots so they sit above other papers' dots.
  // Then each starred paper's own dot is raised on top of its star.
  const STAR_EXTRA = 16;
  const K_STAR     = 0.775;
  const starArea   = d => Math.pow(hitR(d) + STAR_EXTRA, 2) * K_STAR;
  dotsG.selectAll('path.star-glow').data(sorted).join('path').attr('class','star-glow')
    .attr('d', d => d3.symbol().type(d3.symbolStar).size(starArea(d))())
    .attr('transform', d => symTransform(d, 1))
    .attr('fill', 'none')
    .attr('stroke', '#C49428').attr('stroke-width', 1.5).attr('stroke-opacity', 0.9)
    .style('filter', null)
    .attr('opacity', d => paperIsVisible(d) ? starGlowOpacity(d) : 0)
    .attr('pointer-events', 'none');

  // Raise each starred paper's dot above its star glow
  dotsG.selectAll('path.pdot').filter(d => d.starred).raise();

  dotsG.selectAll('circle.phit').data(sorted).join('circle').attr('class','phit')
    .attr('r', d => hitR(d))
    .attr('transform', d => 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(1/currentK)+')')
    .attr('fill', 'transparent').attr('stroke', 'none').attr('cursor', 'pointer')
    .on('mouseenter', function(evt, d) {
      if (pinned) return;
      _hoveredDot = d;
      const hi = highlightColor(d);
      const sameCluster = dd => d.clusters.some(c => dd.clusters.includes(c));
      dotsG.selectAll('path.pdot')
        .attr('fill',           dd => dd === d ? hi : dotColor(dd))
        .attr('fill-opacity',   dd => dd === d ? 1   : sameCluster(dd) ? dotOpacity(dd) : 0.06)
        .attr('stroke-opacity', dd => dd === d ? 0.6 : sameCluster(dd) ? dotOpacity(dd) * 0.7 : 0.02);
      dotsG.selectAll('path.star-glow').attr('opacity', dd => dd.starred ? (dd === d ? 0.80 : 0.20) : 0)
        .attr('stroke', dd => dd === d ? hi : '#C49428');
      highlightClusters(d.clusters, d);
      // Defer tooltip — avoids forced layout triggering synthetic mouseleave on phit.
      // Always use dot's actual screen center so tooltip appears at consistent distance.
      const svgRect = svg.node().getBoundingClientRect();
      const t = d3.zoomTransform(svg.node());
      const dotCX = svgRect.left + t.applyX(xSc(d._x));
      const dotCY = svgRect.top  + t.applyY(ySc(d._y));
      requestAnimationFrame(() => { if (!pinned) showTip({ clientX: dotCX, clientY: dotCY }, d); });
    })
    .on('mousemove', function() { /* tooltip stays locked to dot — no cursor tracking */ })
    .on('mouseleave', function(evt, d) {
      if (pinned) return;
      _hoveredDot = null;
      dotsG.selectAll('path.pdot')
        .attr('fill',           dd => dotColor(dd))
        .attr('fill-opacity',   dd => dotOpacity(dd))
        .attr('stroke-opacity', dd => dotOpacity(dd) * 0.7);
      dotsG.selectAll('path.star-glow').attr('opacity', dd => starGlowOpacity(dd))
        .attr('fill', dd => dotColor(dd)).attr('fill-opacity', 0.6).attr('stroke', '#C49428');
      // If cursor already entered a sidebar card, hand off spotlight to it
      // instead of resetting — prevents the phit overlap zone from nuking sidebar hover.
      if (_sbHoveredId) {
        const hov = PAPERS.find(p => p.id === _sbHoveredId);
        if (hov) { applySidebarSpotlight(hov); return; }
      }
      resetClusterHighlight();
      tipEl.style.display = 'none';
    })
    .on('click', function(evt, d) {
      evt.stopPropagation();
      if (pinned === d) {
        pinned = null;
        dotsG.selectAll('path.pdot')
          .attr('fill',           dd => dotColor(dd))
          .attr('fill-opacity',   dd => dotOpacity(dd))
          .attr('stroke-opacity', dd => dotOpacity(dd) * 0.7).style('filter', null);
        dotsG.selectAll('path.star-glow').attr('opacity', dd => starGlowOpacity(dd))
          .attr('fill', dd => dotColor(dd)).attr('fill-opacity', 0.6);
        resetClusterHighlight();
        tipEl.style.display = 'none';
      } else {
        pinned = d;
        const hi = highlightColor(d);
        const sameCluster = dd => d.clusters.some(c => dd.clusters.includes(c));
        dotsG.selectAll('path.pdot')
          .attr('fill',           dd => dd === d ? hi : dotColor(dd))
          .attr('fill-opacity',   dd => dd === d ? 1   : sameCluster(dd) ? dotOpacity(dd) : 0.06)
          .attr('stroke-opacity', dd => dd === d ? 0.6 : sameCluster(dd) ? dotOpacity(dd) * 0.7 : 0.02)
          .style('filter', null)
          .filter(dd => dd === d).raise();
        dotsG.selectAll('path.star-glow').attr('opacity', dd => dd.starred ? (dd === d ? 0.80 : 0.05) : 0)
          .attr('stroke', dd => dd === d ? hi : '#C49428');
        highlightClusters(d.clusters, d);
        const _r = svg.node().getBoundingClientRect(), _t = d3.zoomTransform(svg.node());
        showTip({ clientX: _r.left + _t.applyX(xSc(d._x)), clientY: _r.top + _t.applyY(ySc(d._y)) }, d);
        // Scroll to card in sidebar
        const scrollToCard = () => {
          let sbCard = [...document.querySelectorAll('#sidebar-list .sb-card')]
            .find(c => c.dataset.id === d.id);
          if (!sbCard) {
            renderSidebar();
            sbCard = [...document.querySelectorAll('#sidebar-list .sb-card')]
              .find(c => c.dataset.id === d.id);
          }
          if (sbCard) sbCard.scrollIntoView({ behavior: 'instant', block: 'start' });
        };
        scrollToCard();
        if (d.prestige !== 3) verifyPrestige(d, true);
      }
    });
}

function drawAxes(W, H) {
  axisG.selectAll('*').remove();
  const chartW = W - M.left - M.right;
  const chartH = H - M.top  - M.bottom;
  const barY   = H - M.bottom + 4;
  const barH   = 3;
  const lblY   = barY + barH + 6;
  const isPersonalized = Object.keys(_starredData).length > 0;

  function attachAxisTip(sel, key, hoverColor) {
    const tipCopy = {
      west:  'How things work\u2014theory, interpretability, scaling laws.',
      east:  'What was built\u2014benchmarks, deployed systems, robots.',
      north: isPersonalized
        ? 'Top papers best match your starred interests.'
        : 'Top papers are most relevant to AI/ML. Star papers to personalize.',
    };
    sel.on('mouseenter', function(evt) {
        d3.select(this).style('fill', hoverColor);
        tipEl.innerHTML =
          `<div style="font-size:0.78rem;line-height:1.55;color:${hoverColor};max-width:200px">`
          + tipCopy[key]
          + `<br><span style="opacity:0.38;font-size:0.71rem">Double-click to reset view</span></div>`;
        tipEl.style.display = 'block';
        tipEl.style.pointerEvents = 'none';
        moveTip(evt);
      })
      .on('mousemove', moveTip)
      .on('mouseleave', function() {
        d3.select(this).style('fill', null);
        tipEl.style.display = 'none';
      });
  }

  axisG.append('rect').attr('class','axis-bar')
    .attr('x', M.left).attr('y', barY)
    .attr('width', Math.max(0, chartW)).attr('height', barH).attr('rx', 1.5)
    .attr('fill', 'url(#axis-x-grad)').attr('opacity', 0.55)
    .attr('pointer-events', 'none');

  const _dimFill = 'rgba(19,16,28,0.68)';
  axisG.append('rect').attr('class','vp-dim-left')
    .attr('y', barY - 1).attr('height', barH + 2).attr('rx', 1)
    .attr('fill', _dimFill).attr('pointer-events', 'none')
    .attr('x', M.left).attr('width', 0);
  axisG.append('rect').attr('class','vp-dim-right')
    .attr('y', barY - 1).attr('height', barH + 2).attr('rx', 1)
    .attr('fill', _dimFill).attr('pointer-events', 'none')
    .attr('x', M.left + chartW).attr('width', 0);

  attachAxisTip(axisG.append('text').attr('class','axis-label axis-west')
    .attr('x', M.left).attr('y', lblY).attr('dy','0.35em').attr('text-anchor','start')
    .style('fill', axisColor(0)).text('Mechanism'), 'west', axisColor(0.03));

  attachAxisTip(axisG.append('text').attr('class','axis-label axis-east')
    .attr('x', M.left + chartW).attr('y', lblY).attr('dy','0.35em').attr('text-anchor','end')
    .style('fill', axisColor(1)).text('Application'), 'east', axisColor(0.88));

  axisG.append('rect').attr('class','axis-bar-y')
    .attr('x', M.left - 4).attr('y', M.top)
    .attr('width', 3).attr('height', Math.max(0, chartH)).attr('rx', 1.5)
    .attr('fill', 'url(#axis-y-grad)').attr('opacity', 0.7)
    .attr('pointer-events', 'none');

  attachAxisTip(axisG.append('text').attr('class','axis-label axis-north')
    .attr('x', M.left + 13).attr('y', 13).attr('dy','0.35em').attr('text-anchor','start')
    .text(isPersonalized ? 'Your interests' : 'Relevance'), 'north', '#C49428');

  axisG.append('text').attr('class','axis-label axis-south')
    .attr('x', M.left).attr('y', barY - 5).attr('text-anchor','start')
    .text('Low relevance')
    .style('opacity', isPersonalized ? 0 : 1);
}

function draw() {
  if (!PAPERS.length) return;
  const W = chartEl.clientWidth, H = chartEl.clientHeight;
  const PW = W * SCALE, PH = H * SCALE;
  svg.attr('viewBox', '0 0 '+W+' '+H);

  applyJitter();

  const PAD = 0.08;
  const xs = PAPERS.map(p => p._x), ys = PAPERS.map(p => p._y);
  xSc = d3.scaleLinear().domain([Math.min(...xs) - PAD, Math.max(...xs) + PAD]).range([M.left, PW - M.right]);
  ySc = d3.scaleLinear().domain([Math.min(...ys) - PAD, Math.max(...ys) + PAD]).range([PH - M.bottom, M.top]);
  svg.call(zoom.transform, d3.zoomIdentity.scale(1 / SCALE));

  gridG.selectAll('*').remove();
  drawBlobs();
  drawDots();
  drawAxes(W, H);
}

// Swap N/S axis labels without a full redraw (called on star toggle).
function updateAxisLabel() {
  const isPersonalized = Object.keys(_starredData).length > 0;
  axisG.selectAll('text.axis-north').text(isPersonalized ? 'Your interests' : 'Relevance');
  axisG.selectAll('text.axis-south').style('opacity', isPersonalized ? 0 : 1);
}


// ═══════════════════════════════════════════════════════
// SIDEBAR TOGGLE
// ═══════════════════════════════════════════════════════

// Track the tooltip to the pinned dot each frame while the sidebar slides.
let _slideRaf = null;

function _trackTipDuringSlide() {
  if (!pinned || tipEl.style.display === 'none') { _slideRaf = null; return; }
  const svgRect = document.getElementById('chart').getBoundingClientRect();
  const t = d3.zoomTransform(svg.node());
  const dotScreenX = svgRect.left + t.applyX(xSc(pinned._x));
  const dotScreenY = svgRect.top  + t.applyY(ySc(pinned._y));
  moveTip({ clientX: dotScreenX, clientY: dotScreenY });
  _slideRaf = requestAnimationFrame(_trackTipDuringSlide);
}

function startTipTracking() {
  if (_slideRaf) cancelAnimationFrame(_slideRaf);
  _slideRaf = requestAnimationFrame(_trackTipDuringSlide);
}

function stopTipTracking() {
  if (_slideRaf) { cancelAnimationFrame(_slideRaf); _slideRaf = null; }
  // Sync lastTipEvt to the dot's final screen position so future showTip calls
  // (e.g. from prestige verification completing) don't jump to the old cursor spot.
  if (pinned && tipEl.style.display !== 'none') {
    const svgRect = document.getElementById('chart').getBoundingClientRect();
    const t = d3.zoomTransform(svg.node());
    lastTipEvt = {
      clientX: svgRect.left + t.applyX(xSc(pinned._x)),
      clientY: svgRect.top  + t.applyY(ySc(pinned._y)),
    };
  }
}

const sidebarEl = document.getElementById('sidebar');
sidebarEl.addEventListener('transitionend', stopTipTracking);



// ═══════════════════════════════════════════════════════
// LIVE UPDATE — re-render any open tab when new papers land in storage
// ═══════════════════════════════════════════════════════
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const incoming = changes.processedPapers?.newValue;
  if (!incoming?.length) return;
  // Only re-render if this is genuinely new data (different date or more papers)
  const today = arxivDate();
  const newDate = changes.lastFetch?.newValue ?? today;
  if (PAPERS.length > 0 && newDate === document.getElementById('header-date').textContent && incoming.length === PAPERS.length) return;
  chrome.storage.local.get(['lastFetch','appliedHistory'], ({ lastFetch, appliedHistory }) => renderPapers(incoming, lastFetch, appliedHistory));
});

// ═══════════════════════════════════════════════════════
// REFRESH & MESSAGE HANDLING
// ═══════════════════════════════════════════════════════
document.getElementById('refresh-btn').addEventListener('click', () => {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.classList.add('spinning');
  // Clear cached data so loadAndRender enters the polling loop instead of
  // instantly re-rendering stale papers. Background will re-fetch everything.
  // Hard reset of all fetch locks and rate-limit state so doFetchAndCache
  // gets a clean run. processedPapers intentionally kept — stale papers are
  // better than a blank spinner; storage.onChanged will re-render when done.
  chrome.storage.local.set({
    fetchInProgress: false, fetchStartedAt: null,
    fetchRetryAfter: null, fetchError: null,
    lastFetch: null, papers: [],
  }, () => {
    chrome.runtime.sendMessage({ action: 'refresh' });
    loadAndRender(); // shows loading overlay + elapsed timer + polls for completion
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'dataUpdated') loadAndRender();
});

new ResizeObserver(draw).observe(chartEl);
loadAndRender();
