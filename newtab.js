// ═══════════════════════════════════════════════════════
// PAPER STORAGE & CONSTANTS
// ═══════════════════════════════════════════════════════
let PAPERS = [];

const CAT_COLOR  = { 'cs.CL':'#5899DA','cs.CV':'#6DAB5A','cs.RO':'#E47D43','cs.CR':'#E1543E','cs.LG':'#9B6BBA','cs.AI':'#94A3B8','cs.HC':'#E891BD','cs.IR':'#7DBFCC' };
const CAT_LABEL  = { 'cs.CL':'NLP','cs.CV':'Vision','cs.RO':'Robotics','cs.CR':'Safety','cs.LG':'ML Methods','cs.AI':'General AI','cs.HC':'HCI','cs.IR':'Retrieval' };
const FMT_LABEL  = { empirical:'Empirical', benchmark:'Benchmark', survey:'Survey', theory:'Theory', position:'Position' };
const FMT_COLOR  = { empirical:'#5899DA', benchmark:'#F3B839', survey:'#9B6BBA', theory:'#7DBFCC', position:'#E47D43' };
const D3_SYMBOL  = { empirical:d3.symbolCircle, benchmark:d3.symbolTriangle, survey:d3.symbolSquare, theory:d3.symbolStar, position:d3.symbolDiamond };

let ALL_CLUSTERS = [];
const ALL_CATS     = ['cs.CR','cs.CL','cs.CV','cs.RO','cs.LG','cs.AI','cs.HC','cs.IR'];
const ALL_FORMATS  = ['empirical','benchmark','survey','theory','position'];
const ALL_PRESTIGE = [3, 2, 1];
const PRESTIGE_LABEL = { 3:'★★★ Frontier', 2:'★★ Research', 1:'★ Other' };
const PRESTIGE_COLOR = { 3:'#D7C4E3',      2:'#94A3B8',     1:'rgba(241,240,222,0.42)' };
let activeCats     = new Set(ALL_CATS);
let activeFormats  = new Set(ALL_FORMATS);
let activePrestige = new Set(ALL_PRESTIGE);
let starFilterActive = false;
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
  const text = (title + ' ' + summary).toLowerCase();
  if (/\b(benchmark|dataset|leaderboard|evaluation suite|corpus|annotated)\b/.test(text)) return 'benchmark';
  if (/\b(survey|overview|review|tutorial|comprehensive study|systematic review)\b/.test(text)) return 'survey';
  if (/\b(theorem|lemma|proof|regret bound|sample complexity|convergence rate|upper bound|lower bound|pac learning|information.theoretic|complexity analysis|formal(ly| proof)|provably)\b/.test(text)) return 'theory';
  if (/\b(position paper|we argue|we contend|we call for|we urge|manifesto|perspective|opinion)\b/.test(text)) return 'position';
  return 'empirical';
}
function scoreApplied(title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  const a = ['deploy','real-world','production','industry','application','practical','clinical','medical','healthcare','commercial','on-device','edge','robot','autonomous','user study','human evaluation','user interface','open-source','open source','released','api','pipeline','end-to-end system','in the wild','case study','field study','we implement','system design'].filter(t=>text.includes(t)).length;
  const th = ['theorem','lemma','proof','regret','sample complexity','convergence rate','upper bound','lower bound','pac learning','formally','asymptotic','theoretical analysis','minimax','information-theoretic','we prove','we show that','hardness','np-hard','complexity class','tight bound','impossibility','approximation ratio','competitive ratio','optimal algorithm'].filter(t=>text.includes(t)).length;
  // Base 0.38 (slight theory-lean) so neutral papers don't pile up at centre.
  // Each theory term subtracts 0.15; each applied term adds 0.11.
  return Math.min(1, Math.max(0, 0.38 + a * 0.11 - th * 0.15));
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
function buildTFIDF(papers) {
  const docs = papers.map(p => tokenize(p.title + ' ' + (p.summary || '')));
  const N = docs.length;
  const df = {};
  docs.forEach(tokens => new Set(tokens).forEach(t => df[t] = (df[t]||0)+1));
  const vocab = Object.keys(df).filter(t => df[t] >= 2 && df[t] <= N / 2)
    .sort((a,b) => Math.log((N+1)/(df[b]+1)) - Math.log((N+1)/(df[a]+1))).slice(0, 400);
  const vi = {}; vocab.forEach((t,i) => vi[t] = i);
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
function cosineSim(a, b) { let dot=0; for (let i=0;i<a.length;i++) dot+=a[i]*b[i]; return dot; }
function kmeansCluster(vectors, k, maxIter) {
  k = k || 12; maxIter = maxIter || 25;
  if (!vectors.length) return new Int32Array(0);
  const n=vectors.length, dim=vectors[0].length;
  k = Math.min(k, n);
  let s=42;
  const rng=()=>{s=(s*1664525+1013904223)&0xffffffff;return (s>>>0)/0xffffffff;};
  const centroids=[vectors[Math.floor(rng()*n)]];
  while(centroids.length<k){
    const dists=vectors.map(v=>1-Math.max(0,...centroids.map(c=>cosineSim(v,c))));
    const sum=dists.reduce((a,b)=>a+b,0);let r=rng()*sum,picked=false;
    for(let i=0;i<n;i++){r-=dists[i];if(r<=0){centroids.push(vectors[i]);picked=true;break;}}
    if(!picked)centroids.push(vectors[Math.floor(rng()*n)]);
  }
  const assignments=new Int32Array(n);
  for(let iter=0;iter<maxIter;iter++){
    let changed=false;
    for(let i=0;i<n;i++){let best=0,bestSim=-Infinity;for(let j=0;j<k;j++){const sim=cosineSim(vectors[i],centroids[j]);if(sim>bestSim){bestSim=sim;best=j;}}if(assignments[i]!==best){assignments[i]=best;changed=true;}}
    if(!changed)break;
    for(let j=0;j<k;j++){const c=new Float32Array(dim);let cnt=0;for(let i=0;i<n;i++)if(assignments[i]===j){for(let d=0;d<dim;d++)c[d]+=vectors[i][d];cnt++;}if(!cnt)continue;const norm=Math.sqrt(c.reduce((s,x)=>s+x*x,0))||1;for(let d=0;d<dim;d++)centroids[j][d]=c[d]/norm;}
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
function classifyPaper(title, summary, cat) {
  const text = (title + ' ' + summary).toLowerCase();
  let best = null, bestScore = 0;
  for (const {name,keys} of CLUSTER_MAP) {
    const score = keys.filter(k => text.includes(k)).length;
    if (score > bestScore) { bestScore=score; best=name; }
  }
  return best || 'General ML';
}
function processRawPapers(rawPapers) {
  if (!rawPapers.length) return [];
  return rawPapers.map(p => {
    const cat = (p.categories||[]).find(c=>c.startsWith('cs.'))||p.categories?.[0]||'cs.AI';
    const cluster = classifyPaper(p.title, p.summary||'', cat);
    return { id:p.arxivId, title:p.title, gist:(p.summary||'').slice(0,200).replace(/\s+/g,' ').toLowerCase(),
      cat, format:classifyFormat(p.title,p.summary||''), applied:scoreApplied(p.title,p.summary||''),
      relevance:scoreRelevance(cat,p.title,p.summary||''), upvotes:p.upvotes||0, trending:p.trending||false,
      starred:false, clusters:[cluster], _absLink:p.absLink||'https://arxiv.org/abs/'+p.arxivId,
      _pdfLink:p.pdfLink||'https://arxiv.org/pdf/'+p.arxivId,
      _authors:(p.authors||[]).slice(0,3).join(', '), _summary:p.summary||'' };
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
    _starredData[p.id] = { title: p.title, summary: p._summary || '' };
  } else {
    delete _starredData[p.id];
  }
  saveStarred();
  dotsG.selectAll('circle.star-glow').filter(d => d === p)
    .attr('opacity', p.starred ? 0.30 : 0);
  if (pinned === p) showTip(lastTipEvt, p);
  const n = PAPERS.filter(p=>p.starred).length;
  const sc = document.getElementById('star-count');
  if (sc) sc.textContent = n;
  // Recompute Y positions and animate dots into new positions
  applyJitter();
  animateDots();
  updateAxisLabel();
  updateAxisNote();
}

// ═══════════════════════════════════════════════════════
// CHROME STORAGE & LOADING
// ═══════════════════════════════════════════════════════
async function loadAndRender() {
  const data = await new Promise(r =>
    chrome.storage.local.get(['processedPapers','papers','lastFetch','fetchError','fetchInProgress'], r)
  );

  if (data.processedPapers?.length > 0) {
    // Render immediately — stale papers beat a blank screen.
    await renderPapers(data.processedPapers, data.lastFetch);
    // If cache is from a previous day AND there's no ongoing fetch AND the last
    // attempt didn't fail, silently trigger a background refresh.
    // Skip if fetchError is set — the user can hit Retry manually. Otherwise
    // we'd loop forever re-triggering failed fetches.
    const today = new Date().toISOString().slice(0, 10);
    if (data.lastFetch !== today && !data.fetchInProgress) {
      // Always attempt a refresh for stale papers — even if a previous fetch
      // failed overnight. Clear the error so doFetchAndCache gets a clean run.
      chrome.storage.local.set({ lastFetch: null, fetchError: null }, () => {
        chrome.runtime.sendMessage({ action: 'refresh' });
      });
    }
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
    const d = await new Promise(r => chrome.storage.local.get(['processedPapers','papers','fetchError','fetchInProgress','fetchRetryAfter'], r));

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
}

async function renderPapers(processedPapers, lastFetch) {
  // Re-enable refresh button (may have been disabled during a manual refresh)
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.classList.remove('spinning'); }

  PAPERS = processedPapers;
  loadStarred();

  ALL_CLUSTERS.length = 0;
  const seen = new Set();
  PAPERS.forEach(p => p.clusters.forEach(c => { if (!seen.has(c)) { seen.add(c); ALL_CLUSTERS.push(c); } }));

  if (lastFetch) document.getElementById('header-date').textContent = lastFetch;
  document.getElementById('vis-count').textContent = PAPERS.length;

  buildClusterBar();
  buildLegend();

  activeCats     = new Set(ALL_CATS.filter(c => PAPERS.some(p => p.cat === c)));
  activeFormats  = new Set(ALL_FORMATS.filter(f => PAPERS.some(p => p.format === f)));
  activePrestige = new Set(ALL_PRESTIGE.filter(t => PAPERS.some(p => (p.prestige ?? 1) === t)));

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
}

// ─── Build cluster bar ───
function buildClusterBar() {
  const clusterBarEl = document.getElementById('cluster-bar');
  clusterBarEl.innerHTML = '';
  const sortedClusters = [...ALL_CLUSTERS].sort((a,b) =>
    PAPERS.filter(p=>p.clusters.includes(b)).length -
    PAPERS.filter(p=>p.clusters.includes(a)).length
  );
  sortedClusters.forEach(name => {
    const members  = PAPERS.filter(p => p.clusters.includes(name));
    const catTally = {};
    members.forEach(p => { catTally[p.cat] = (catTally[p.cat]||0) + 1; });
    const domCat   = Object.entries(catTally).sort((a,b)=>b[1]-a[1])[0][0];
    const color    = CAT_COLOR[domCat] || '#94A3B8';
    const btn = document.createElement('button');
    btn.className   = 'cluster-btn';
    btn.style.color = color;
    btn.style.borderColor = color;
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
  const legendEl = document.getElementById('legend');
  legendEl.innerHTML = '';

  const fieldSec = document.createElement('div');
  fieldSec.innerHTML = '<div class="leg-section-title">Field \u00b7 color</div>';
  const fieldBtns = document.createElement('div');
  fieldBtns.className = 'leg-btns single-col';
  ALL_CATS.forEach(cat => {
    const count = PAPERS.filter(p => p.cat === cat).length;
    if (!count) return;
    const btn = document.createElement('button');
    btn.className = 'filter-btn active';
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

  const FMT_SYM = { empirical:'\u25cf', benchmark:'\u25b2', survey:'\u25a0', theory:'\u2605', position:'\u25c6' };
  const fmtSec = document.createElement('div');
  fmtSec.innerHTML = '<div class="leg-section-title">Format \u00b7 shape</div>';
  const fmtBtns = document.createElement('div');
  fmtBtns.className = 'leg-btns single-col';
  ALL_FORMATS.forEach(fmt => {
    const count = PAPERS.filter(p => p.format === fmt).length;
    const btn = document.createElement('button');
    btn.className = 'filter-btn active';
    btn.style.color = FMT_COLOR[fmt];
    btn.style.borderColor = FMT_COLOR[fmt];
    btn.innerHTML = FMT_SYM[fmt] + ' ' + FMT_LABEL[fmt] + ' <span class="fb-count">' + count + '</span>';
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
  prestSec.innerHTML = '<div class="leg-section-title">Prestige \u00b7 size</div>';
  const prestBtns = document.createElement('div');
  prestBtns.className = 'leg-btns single-col';
  ALL_PRESTIGE.forEach(tier => {
    const count = PAPERS.filter(p => (p.prestige ?? 1) === tier).length;
    const btn = document.createElement('button');
    btn.className = 'filter-btn active';
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
  starWrapper.innerHTML = '<div class="leg-section-title">Starred</div>';
  const starSec = document.createElement('div');
  starSec.className = 'leg-btns single-col';
  const starN = PAPERS.filter(p => p.starred).length;
  const starBtn = document.createElement('button');
  starBtn.className = 'filter-btn star-btn';
  starBtn.id = 'star-filter-btn';
  starBtn.innerHTML = '\u2605 Show only <span class="fb-count" id="star-count">' + starN + '</span>';
  starBtn.addEventListener('click', () => {
    starFilterActive = !starFilterActive;
    starBtn.classList.toggle('active', starFilterActive);
    updateVisibility();
  });
  starSec.appendChild(starBtn);
  starWrapper.appendChild(starSec);
  legendEl.appendChild(starWrapper);

  const navSec = document.createElement('div');
  navSec.innerHTML = '<div class="leg-note">zoom: scroll/pinch<br>pin: click dot</div>';
  legendEl.appendChild(navSec);

  const axisNoteEl = document.createElement('div');
  axisNoteEl.id = 'axis-note';
  legendEl.appendChild(axisNoteEl);
  updateAxisNote();
}

// ═══════════════════════════════════════════════════════
// SVG & ZOOM SETUP
// ═══════════════════════════════════════════════════════
const svg     = d3.select('#chart');
const clusterNameEl = document.getElementById('cluster-name-display');
const chartEl = document.getElementById('chart-area');
const M       = { top:44, right:28, bottom:50, left:44 };

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

const BLOB_FILL_DIM  = 0.00,  BLOB_FILL_BASE  = 0.04,  BLOB_FILL_HI  = 0.40;
const BLOB_STRK_DIM  = 0.03,  BLOB_STRK_BASE  = 0.18,  BLOB_STRK_HI  = 1.00;

// Prestige opacity — module-level so click handlers outside renderPapers can use it
const PRESTIGE_OPACITY = { 1: 0.28, 2: 0.75, 3: 1.00 };
const dotOpacity = d => PRESTIGE_OPACITY[d.prestige ?? 1];

const SCALE = 3;
let currentK = 1 / SCALE;
const zoom = d3.zoom().scaleExtent([0.25, 12])
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
    dotsG.selectAll('circle.star-glow')
      .attr('transform', d => 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(1/currentK)+')');
  });
svg.call(zoom);

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

function showTip(evt, p) {
  _tipPaper = p;
  const clusterChips = p.clusters.map(c => {
    const active = !activeClusters.size || activeClusters.has(c);
    return '<span class="tt-cluster-chip active-chip" data-tip-action="toggleCluster" data-cluster="'+esc(c)+'" style="cursor:pointer;opacity:'+(active?'1':'0.38')+'">'+esc(c)+'</span>';
  }).join(' ');
  const catActive  = activeCats.has(p.cat);
  const fmtActive  = activeFormats.has(p.format);
  const tier       = p.prestige ?? 1;
  const tierActive = activePrestige.has(tier);
  const badgeStyle = (color, active) =>
    'color:'+color+';border-color:'+color+';cursor:pointer;opacity:'+(active?'1':'0.38')+';';
  tipEl.innerHTML =
    // Prestige badge — upper right, clickable to filter
    '<span class="tt-prestige" data-tip-action="togglePrestige" data-tier="'+tier+'" style="color:'+PRESTIGE_COLOR[tier]+';opacity:'+(tierActive?'1':'0.38')+'">'+PRESTIGE_LABEL[tier]+'</span>'+
    '<div class="tt-clusters">'+clusterChips+'</div>'+
    '<div class="tt-title">'+esc(p.title)+'</div>'+
    '<div class="tt-gist">'+esc(p.gist)+'</div>'+
    '<div class="tt-badges">'+
      '<span class="tt-badge" data-tip-action="toggleCat" data-cat="'+p.cat+'" style="'+badgeStyle(CAT_COLOR[p.cat], catActive)+'">'+CAT_LABEL[p.cat]+'</span>'+
      '<span class="tt-badge" data-tip-action="toggleFmt" data-fmt="'+p.format+'" style="'+badgeStyle(FMT_COLOR[p.format], fmtActive)+'">'+FMT_LABEL[p.format]+'</span>'+
      (p.trending ? '<span class="tt-badge" style="color:#6DAB5A;border-color:#6DAB5A">\u25b2 '+p.upvotes+' HF</span>' : '')+
    '</div>'+
    '<div class="tt-authors"><a href="'+esc(p._absLink)+'" target="_blank" style="color:rgba(241,240,222,0.45);text-decoration:underline">arxiv:'+esc(p.id)+' \u2197</a></div>'+
    '<a class="tt-pdf-btn" href="'+esc(p._pdfLink||'https://arxiv.org/pdf/'+p.id)+'" target="_blank">\ud83d\udcc4 Open this PDF</a>'+
    '<button class="tt-star-btn '+(p.starred?'starred':'')+'" data-tip-action="star">'+
      (p.starred ? '\u2605 Starred \u2014 click to unstar' : '\u2606 Star this paper')+
    '</button>'+
    '<div class="tt-hint" style="margin-top:6px">'+(pinned===p?'click dot again to unpin':'click to pin \u00b7 chips toggle filters')+'</div>';
  lastTipEvt = evt;
  tipEl.style.display = 'block';
  moveTip(evt);
}

function moveTip(evt) {
  const pad=14, tw=tipEl.offsetWidth, th=tipEl.offsetHeight;
  let lx = evt.clientX+pad, ly = evt.clientY-pad;
  if (lx+tw > window.innerWidth-8)  lx = evt.clientX-tw-pad;
  if (ly+th > window.innerHeight-8) ly = evt.clientY-th-pad;
  tipEl.style.left = lx+'px'; tipEl.style.top = ly+'px';
}

document.addEventListener('click', e => {
  if (!e.target.closest('#tooltip') && !e.target.closest('.phit')) {
    pinned = null; tipEl.style.display = 'none';
    dotsG?.selectAll('path.pdot').attr('fill-opacity', dd => dotOpacity(dd)).attr('stroke-opacity', dd => dotOpacity(dd) * 0.7).style('filter', null);
    resetClusterHighlight();
  }
});

// ═══════════════════════════════════════════════════════
// CLUSTER HIGHLIGHT
// ═══════════════════════════════════════════════════════
const clusterBarEl = document.getElementById('cluster-bar');

function highlightClusters(activePaperClusters) {
  const active = new Set(activePaperClusters);
  blobsG.selectAll('.blob-fill')
    .attr('opacity', d => active.has(d.cluster) ? BLOB_FILL_HI : BLOB_FILL_DIM)
    .attr('filter', d => active.has(d.cluster) ? 'url(#blob-glow)' : 'url(#blob-blur)');
  blobsG.selectAll('.blob-stroke')
    .attr('opacity', d => active.has(d.cluster) ? BLOB_STRK_HI : BLOB_STRK_DIM)
    .attr('stroke-width', d => active.has(d.cluster) ? 4 : 3);
  clusterBarEl.querySelectorAll('.cluster-btn').forEach(btn => {
    btn.classList.toggle('lit', active.has(btn.dataset.cluster));
  });
  clusterNameEl.textContent = [...active].join(' \u00b7 ');
  clusterNameEl.style.opacity = 1;
}

function resetClusterHighlight() {
  blobsG.selectAll('.blob-fill')
    .attr('opacity', d => clusterHasVisiblePaper(d.cluster) ? BLOB_FILL_BASE : BLOB_FILL_DIM)
    .attr('filter', 'url(#blob-blur)');
  blobsG.selectAll('.blob-stroke')
    .attr('opacity', d => clusterHasVisiblePaper(d.cluster) ? BLOB_STRK_BASE : BLOB_STRK_DIM)
    .attr('stroke-width', 3);
  clusterBarEl.querySelectorAll('.cluster-btn').forEach(btn => btn.classList.remove('lit'));
  clusterNameEl.style.opacity = 0;
}

function matchesSearch(d) {
  if (!searchQuery) return true;
  const q = searchQuery;
  return d.title.toLowerCase().includes(q)
    || (d.gist     || '').includes(q)
    || (d._authors || '').toLowerCase().includes(q);
}

function paperIsVisible(d) {
  return activeCats.has(d.cat)
    && activeFormats.has(d.format)
    && activePrestige.has(d.prestige ?? 2)
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

  dotsG.selectAll('path.pdot').attr('opacity', d => visibleIds.has(d.id) ? 0.88 : 0.05);
  dotsG.selectAll('.phit').attr('pointer-events', d => visibleIds.has(d.id) ? 'all' : 'none');
  // Star ring only shows when the paper itself is visible
  dotsG.selectAll('circle.star-glow').attr('opacity', d => (d.starred && visibleIds.has(d.id)) ? 0.80 : 0);

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

  if (activeClusters.size) highlightClusters([...activeClusters]);
  else resetClusterHighlight();
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
  const JITTER_X = 0.24; // wider horizontal spread to fill theoretical side
  const JITTER_Y = 0.09;
  const isPersonalized = Object.keys(_starredData).length > 0;
  PAPERS.forEach(p => {
    const rng  = seededRand(parseInt(p.id.replace('.','')) || 12345);
    const yBase = isPersonalized
      ? (scoreAffinity(p, _starredData) ?? p.relevance)
      : p.relevance;
    p._x = Math.max(0.01, Math.min(0.99, p.applied + (rng() - 0.5) * 2 * JITTER_X));
    p._y = Math.max(0.01, Math.min(0.99, yBase     + (rng() - 0.5) * 2 * JITTER_Y));
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
  dotsG.selectAll('circle.star-glow').transition().duration(dur).ease(d3.easeCubicInOut)
    .attr('transform', d => 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(1/currentK)+')');
}

// ═══════════════════════════════════════════════════════
// DRAW
// ═══════════════════════════════════════════════════════
let xSc, ySc;

function draw() {
  if (!PAPERS.length) return;
  const W = chartEl.clientWidth, H = chartEl.clientHeight;
  const PW = W * SCALE, PH = H * SCALE;
  svg.attr('viewBox', '0 0 '+W+' '+H);

  xSc = d3.scaleLinear().domain([0,1]).range([M.left, PW - M.right]);
  ySc = d3.scaleLinear().domain([0,1]).range([PH - M.bottom, M.top]);

  applyJitter();
  svg.call(zoom.transform, d3.zoomIdentity.scale(1 / SCALE));

  // Grid
  gridG.selectAll('*').remove();
  [0.25,0.5,0.75].forEach(v => {
    gridG.append('line').attr('x1',xSc(v)).attr('x2',xSc(v)).attr('y1',ySc(0)).attr('y2',ySc(1))
      .attr('stroke','rgba(196,148,40,0.07)').attr('stroke-width',1);
    gridG.append('line').attr('x1',xSc(0)).attr('x2',xSc(1)).attr('y1',ySc(v)).attr('y2',ySc(v))
      .attr('stroke','rgba(196,148,40,0.07)').attr('stroke-width',1);
  });
  gridG.append('line').attr('x1',xSc(0.5)).attr('x2',xSc(0.5)).attr('y1',ySc(0)).attr('y2',ySc(1))
    .attr('stroke','rgba(196,148,40,0.18)').attr('stroke-width',1).attr('stroke-dasharray','4,8');
  gridG.append('line').attr('x1',xSc(0)).attr('x2',xSc(1)).attr('y1',ySc(0.5)).attr('y2',ySc(0.5))
    .attr('stroke','rgba(196,148,40,0.18)').attr('stroke-width',1).attr('stroke-dasharray','4,8');

  // Blobs
  blobsG.selectAll('*').remove();
  ALL_CLUSTERS.forEach(name => {
    const members = PAPERS.filter(p => p.clusters.includes(name));
    if (members.length < 2) return;
    const pts = members.map(p => [xSc(p._x), ySc(p._y)]);
    const cx  = d3.mean(pts, d=>d[0]);
    const cy  = d3.mean(pts, d=>d[1]);
    const catCount = d3.rollup(members, v=>v.length, d=>d.cat);
    const domCat   = [...catCount].sort((a,b)=>b[1]-a[1])[0][0];
    const color    = CAT_COLOR[domCat] || '#94A3B8';
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
      .attr('fill',color).attr('opacity',BLOB_FILL_BASE).attr('filter','url(#blob-blur)');
    blobsG.append('path').datum({cluster:name})
      .attr('class','blob-stroke').attr('d',pathStr)
      .attr('fill','none').attr('stroke',color).attr('opacity',BLOB_STRK_BASE).attr('stroke-width',3);
  });

  // Dots
  dotsG.selectAll('*').remove();
  // Base symbol area (px²) and hit radius — both scale with prestige tier.
  // Tier 3 (frontier labs / elite universities): 1.5× area → √1.5 ≈ 1.22× radius
  // Tier 2 (default / unknown): 1×
  // Tier 1 (small/unrecognised institution): 0.5× area → √0.5 ≈ 0.71× radius
  const SYM_BASE = 310, HIT_BASE = 18;
  const PRESTIGE_AREA = { 1: 0.50, 2: 1.00, 3: 1.50 };
  const symSize = d => SYM_BASE * (PRESTIGE_AREA[d.prestige] ?? 1.0);
  const hitR    = d => HIT_BASE * Math.sqrt(PRESTIGE_AREA[d.prestige] ?? 1.0);

  function symTransform(d, scl) {
    return 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(scl/currentK)+')';
  }

  // Star ring: stroke only so the dot shape/colour is never obscured,
  // and pointer-events:none so it never intercepts clicks.
  // Visibility is managed by updateVisibility (only show when paper is visible).
  dotsG.selectAll('circle.star-glow').data(PAPERS).join('circle').attr('class','star-glow')
    .attr('r', d => hitR(d) + 3)
    .attr('transform', d => 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(1/currentK)+')')
    .attr('fill', 'none')
    .attr('stroke', '#F3B839').attr('stroke-width', 2)
    .attr('opacity', d => d.starred ? 0.80 : 0)
    .attr('pointer-events', 'none');

  dotsG.selectAll('path.pdot').data(PAPERS).join('path').attr('class','pdot')
    .attr('d', d => d3.symbol().type(D3_SYMBOL[d.format] || d3.symbolCircle).size(symSize(d))())
    .attr('transform', d => symTransform(d, 1))
    .attr('fill', d => CAT_COLOR[d.cat] || '#94A3B8').attr('fill-opacity', d => dotOpacity(d))
    .attr('stroke', d => CAT_COLOR[d.cat] || '#94A3B8').attr('stroke-width', 0.8).attr('stroke-opacity', d => dotOpacity(d) * 0.7)
    .attr('pointer-events', 'none');

  dotsG.selectAll('circle.phit').data(PAPERS).join('circle').attr('class','phit')
    .attr('r', d => hitR(d))
    .attr('transform', d => 'translate('+xSc(d._x)+','+ySc(d._y)+') scale('+(1/currentK)+')')
    .attr('fill', 'transparent').attr('stroke', 'none').attr('cursor', 'pointer')
    .on('mouseenter', function(evt, d) {
      if (pinned) return;
      // Raise lightness in HSL space — keeps hue and saturation, avoids the
      // RGB brightness hue-shift (orange→yellow etc.)
      const base = d3.hsl(CAT_COLOR[d.cat] || '#94A3B8');
      base.l = Math.min(0.88, base.l + 0.32);
      dotsG.selectAll('path.pdot').filter(dd => dd === d)
        .attr('fill', base.formatHex()).attr('fill-opacity', 1).raise();
      highlightClusters(d.clusters);
      showTip(evt, d);
    })
    .on('mousemove', function(evt) { if (!pinned) moveTip(evt); })
    .on('mouseleave', function(evt, d) {
      if (pinned) return;
      dotsG.selectAll('path.pdot').filter(dd => dd === d)
        .attr('fill', CAT_COLOR[d.cat] || '#94A3B8')
        .attr('fill-opacity', dotOpacity(d));
      resetClusterHighlight();
      tipEl.style.display = 'none';
    })
    .on('click', function(evt, d) {
      evt.stopPropagation();
      if (pinned === d) {
        // Unpin: restore all dots
        pinned = null;
        dotsG.selectAll('path.pdot')
          .attr('fill-opacity', dd => dotOpacity(dd))
          .attr('stroke-opacity', dd => dotOpacity(dd) * 0.7).style('filter', null);
        tipEl.style.display = 'none';
        resetClusterHighlight();
      } else {
        pinned = d;
        dotsG.selectAll('path.pdot')
          .attr('fill-opacity', dd => dd === d ? 1 : 0.08)
          .attr('stroke-opacity', dd => dd === d ? 0.6 : 0.03)
          .style('filter', null)
          .filter(dd => dd === d).raise();
        highlightClusters(d.clusters);
        showTip(evt, d);
      }
    });

  // Axes — compass-rose layout: N/S/E/W, each centered on its edge midpoint
  axisG.selectAll('*').remove();
  const chartW = W - M.left - M.right;
  const chartH = H - M.top  - M.bottom;
  const cx = M.left + chartW / 2;
  const cy = M.top  + chartH / 2;
  const isPersonalized = Object.keys(_starredData).length > 0;
  // North: personalized label — class lets updateAxisLabel() swap it live
  axisG.append('text').attr('class','axis-label axis-north')
    .attr('x', cx).attr('y', M.top + 14)
    .attr('text-anchor','middle').text(isPersonalized ? 'Your interests' : 'Relevance');
  // South: only shown in cold-start mode (no stars)
  axisG.append('text').attr('class','axis-label axis-south')
    .attr('x', cx).attr('y', H - M.bottom + 18)
    .attr('text-anchor','middle').text('Low relevance')
    .style('opacity', isPersonalized ? 0 : 0.6);
  // West: Theoretical — vertically centered on the left edge
  axisG.append('text').attr('class','axis-label')
    .attr('x', M.left + 8).attr('y', cy).attr('dy','0.35em')
    .attr('text-anchor','start').text('Theoretical');
  // East: Applied — vertically centered on the right edge
  axisG.append('text').attr('class','axis-label')
    .attr('x', W - M.right - 8).attr('y', cy).attr('dy','0.35em')
    .attr('text-anchor','end').text('Applied');
}

// Swap N/S axis labels without a full redraw (called on star toggle).
function updateAxisLabel() {
  const isPersonalized = Object.keys(_starredData).length > 0;
  axisG.selectAll('text.axis-north').text(isPersonalized ? 'Your interests' : 'Relevance');
  axisG.selectAll('text.axis-south').style('opacity', isPersonalized ? 0 : 0.6);
}

// Update the cold-start / star-count note in the legend sidebar.
function updateAxisNote() {
  const note = document.getElementById('axis-note');
  if (!note) return;
  const n = Object.keys(_starredData).length;
  const todayStarred = PAPERS.filter(p => p.starred).length;
  const prevDays = n - todayStarred; // starred from past days (content saved, no ring today)
  if (n === 0) {
    note.innerHTML = '<div class="leg-note" style="color:rgba(196,148,40,0.55)">★ Star papers to<br>personalize Y axis</div>';
  } else {
    const extra = prevDays > 0 ? ' +'+prevDays+' prev' : '';
    note.innerHTML = '<div class="leg-note" style="color:rgba(196,148,40,0.65)">Y axis: your interests<br>('+todayStarred+' starred today'+extra+')</div>';
  }
}

// ═══════════════════════════════════════════════════════
// REFRESH & MESSAGE HANDLING
// ═══════════════════════════════════════════════════════
document.getElementById('refresh-btn').addEventListener('click', () => {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.classList.add('spinning');
  // Clear cached data so loadAndRender enters the polling loop instead of
  // instantly re-rendering stale papers. Background will re-fetch everything.
  chrome.storage.local.set({ fetchInProgress: false, processedPapers: [], papers: [] }, () => {
    chrome.runtime.sendMessage({ action: 'refresh' });
    loadAndRender(); // shows loading overlay + elapsed timer + polls for completion
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'dataUpdated') loadAndRender();
});

new ResizeObserver(draw).observe(chartEl);
loadAndRender();
