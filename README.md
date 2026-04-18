# arXiv Map — Browser Extension

Replace your new tab with an interactive scatter map of today's arXiv AI/ML papers, clustered by topic and filterable by field, format, and your starred papers.

<img width="1710" height="1107" alt="image" src="https://github.com/user-attachments/assets/9ba8c33b-0a46-4eea-a180-65916bb0bf84" />

## What it does

Every morning the extension fetches that day's papers from arXiv across 8 AI/ML categories (cs.AI, cs.LG, cs.CV, cs.CL, cs.RO, cs.CR, cs.HC, cs.IR). When you open a new tab you see:

- **Scatter plot** — papers positioned by how applied vs. theoretical they are (x-axis) and how relevant to current AI research (y-axis)
- **Topic clusters** — glowing blobs group papers into ~12 auto-detected research areas (Agents & Planning, Image & Video Generation, Reinforcement Learning, etc.)
- **Filters** — toggle by field (color), format (shape: ● empirical, ▲ benchmark, ■ survey...), or your starred papers
- **Tooltips** — hover any dot to see title, abstract gist, field, format, and a direct arxiv link; click to pin
- **Stars** — star papers you want to read later; they persist across sessions

## Install

1. Clone or download this repo
2. Open `brave://extensions` (or `chrome://extensions`)
3. Enable **Developer mode** (toggle top-right)
4. Click **Load unpacked** and select the `arxiv-browser` folder
5. Open a new tab — the extension fetches papers on first install automatically

To update after pulling new changes: go to the extensions page and click the reload ↺ icon on the card. No uninstall needed.

## How it works

```
background.js  — service worker, runs hourly
  ↓ fetches arXiv Atom API + HuggingFace trending
  ↓ caches in chrome.storage.local

newtab.html    — new tab page, runs on open
  ↓ reads from cache (instant, no network)
  ↓ classifies format, scores applied/relevance
  ↓ runs TF-IDF + k-means clustering in JS
  ↓ renders D3 scatter map
```

Clustering is done entirely client-side — no servers, no APIs, no keys needed.

## Structure

```
arxiv-browser/
├── manifest.json    — MV3 manifest, permissions, new tab override
├── background.js    — service worker: fetch, cache, HF trending
├── newtab.html      — scatter map: D3 rendering, clustering, filters
├── icon48.png
└── icon128.png
```

## Customize

**Change which categories are fetched** — edit `CATS` in `background.js`:
```js
const CATS = ['cs.AI','cs.LG','cs.CV','cs.CL','cs.RO','cs.CR','cs.HC','cs.IR'];
```

**Change fetch schedule** — edit `scheduleDailyAlarm()` in `background.js`. Default: checks every hour, skips if already fetched today.

**Change cluster count** — in `newtab.html`, find `const k = Math.min(12, ...)` and adjust.

## Privacy

- No data leaves your browser except the arXiv and HuggingFace API calls
- No analytics, no accounts, no tracking
- Stars are stored in `localStorage` locally

## Requirements

Chrome or Brave, Manifest V3 support (Chrome 88+, Brave equivalent).

## License

MIT
