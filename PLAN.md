# Ottawa New Build Map — Implementation Plan (v2)

## Context
An interactive Ottawa new build map with two phases:
- **Phase 1**: Scrape new build communities → store as JSON → display on map with click-to-detail
- **Phase 2**: Price history tracking, new release alerts, side-by-side builder model comparison

Hosted on **Cloudflare Pages** (free tier) → embeddable as an iframe in a Squarespace site.
Scraper runs on a schedule via **GitHub Actions** (free tier), commits updated JSON, Cloudflare auto-deploys.

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Map | Leaflet.js + CartoDB Positron tiles (CDN) | Free, no API key; Positron = clean minimal tile style |
| Geocoding | Nominatim (OSM) | Free, no key |
| Scraper | Node.js + axios + cheerio | Lightweight HTML scraping |
| JS-rendered fallback | Playwright (globally installed) | Already on system |
| Hosting | **Cloudflare Pages** | Free, global CDN, iframe-embeddable, custom domain |
| Scraper scheduling | **GitHub Actions** (cron) | Free tier, commits updated JSON to repo |
| Squarespace embed | `<iframe src="https://yourapp.pages.dev">` | Works natively in Squarespace Embed block |
| UI design | Vanilla JS + CSS custom properties | Sharp/minimal; no framework overhead |
| Fonts | Inter (text) + JetBrains Mono (data/prices) | Modern, data-forward feel |

---

## Folder Structure

```
/home/user/NewBuildMap/
├── package.json                   # scripts + deps (axios, cheerio)
├── .gitignore                     # node_modules/, data/raw/
├── .github/
│   └── workflows/
│       └── scrape.yml             # scheduled scraper (daily), commits updated JSON
├── scraper/
│   ├── index.js                   # orchestrator: runs all scrapers → builds.json
│   ├── geocode.js                 # Nominatim wrapper (rate-limited, cached)
│   ├── utils.js                   # fetchHTML, sleep, normalizePrice, slugify
│   ├── history.js                 # price history diffing + new release detection
│   └── sources/
│       ├── newinhomes.js          # newinhomes.com/new-homes/ontario/ottawa
│       ├── claridge.js            # claridgehomes.com/communities/
│       ├── mattamy.js             # mattamyhomes.com (Playwright fallback)
│       ├── minto.js               # mintohomes.com/new-homes/ottawa
│       └── tartan.js              # tartanhomes.com
├── data/
│   ├── builds.json                # current snapshot (served to frontend)
│   ├── history/
│   │   ├── prices.json            # price snapshots over time, keyed by build ID
│   │   └── releases.json          # log of new builds/phases detected per scrape run
│   └── raw/                       # per-source cache (gitignored)
└── public/
    ├── index.html                 # main app shell
    ├── app.js                     # map view logic
    ├── compare.js                 # model comparison view logic
    ├── history.js                 # price history chart logic
    ├── style.css                  # design system (CSS vars, sharp/minimal)
    └── components/
        ├── sidebar.js             # build detail panel
        ├── filters.js             # filter bar
        └── toast.js               # "New release" notification toasts
```

---

## Phase 1 Data Schema (`data/builds.json`)

```json
{
  "generated": "2026-04-10T21:00:00Z",
  "count": 42,
  "builds": [
    {
      "id": "claridge-wateridge-village",
      "name": "Wateridge Village",
      "builder": "Claridge Homes",
      "community": "Rockcliffe-Manor Park",
      "address": "750 Aviation Pkwy, Ottawa, ON",
      "lat": 45.4641,
      "lng": -75.6413,
      "type": "townhouse",
      "models": [
        { "name": "The Rideau", "sqft": 1650, "beds": 3, "baths": 2.5, "priceFrom": 649900 },
        { "name": "The Gatineau", "sqft": 1900, "beds": 4, "baths": 3, "priceFrom": 719900 }
      ],
      "priceFrom": 649900,
      "priceFromFormatted": "$649,900",
      "status": "selling",
      "completionYear": 2026,
      "description": "...",
      "sourceUrl": "https://claridgehomes.com/communities/wateridge-village",
      "sourceName": "claridgehomes.com",
      "imageUrl": "https://...",
      "scrapedAt": "2026-04-10T21:00:00Z"
    }
  ]
}
```

---

## Phase 2 Data Schemas

### `data/history/prices.json`
```json
{
  "claridge-wateridge-village": [
    { "date": "2026-01-15", "priceFrom": 629900, "models": { "The Rideau": 629900 } },
    { "date": "2026-03-01", "priceFrom": 649900, "models": { "The Rideau": 649900 } }
  ]
}
```

### `data/history/releases.json`
```json
[
  {
    "date": "2026-03-01",
    "type": "new_build",
    "buildId": "minto-central-park",
    "name": "Central Park",
    "builder": "Minto",
    "priceFrom": 580000
  },
  {
    "date": "2026-04-01",
    "type": "new_model",
    "buildId": "claridge-wateridge-village",
    "model": "The Gatineau",
    "priceFrom": 719900
  },
  {
    "date": "2026-04-01",
    "type": "price_change",
    "buildId": "claridge-wateridge-village",
    "model": "The Rideau",
    "oldPrice": 629900,
    "newPrice": 649900,
    "delta": 20000
  }
]
```

---

## Scraper

### `scraper/history.js` — diff engine
1. Load current `data/builds.json` and `data/history/prices.json`
2. Compare new scrape results against current snapshot
3. Detect: new builds, new models, price changes, status changes
4. Append new price snapshots to `prices.json`
5. Append events to `releases.json`
6. Return summary of changes for the scraper log

### `scraper/index.js` — orchestrator
1. Run each source scraper sequentially (rate-limit safe)
2. Write per-source cache to `data/raw/<source>.json`
3. Merge + deduplicate by normalized `(name + builder)`
4. Geocode any record missing lat/lng
5. **Run history diff** (Phase 2) — detect changes, update history files
6. Write `data/builds.json` with new snapshot

### GitHub Actions (`/.github/workflows/scrape.yml`)
- Trigger: `schedule: cron: '0 6 * * *'` (daily at 6am UTC)
- Steps: checkout → node setup → `npm ci` → `npm run scrape` → commit changed JSON files → push
- Cloudflare Pages auto-deploys on every push to main

---

## UX Design Direction: Tech / Sharp / Simplist

### Visual Language
- **Color scheme**: Near-black background (`#0a0a0f`) + crisp white text + electric cyan accent (`#00d4ff`)
- **Alt light mode**: `#f8f8fc` background + `#0a0a0f` text + same cyan accent (toggleable)
- **No rounded corners** on cards/buttons (sharp 2px borders)
- **Typography**: Inter 400/600 for UI, JetBrains Mono for prices/stats
- **Map tiles**: CartoDB Dark Matter (dark mode) / CartoDB Positron (light mode) — free, no key
- **Markers**: Minimal circles, color-coded by type, subtle glow on hover

### Layout
```
┌─────────────────────────────────────────────────────────────┐
│  OTTAWA NEW BUILDS          [Type ▾] [Builder ▾] [42 shown] │  ← top bar
├──────────────┬──────────────────────────────────────────────┤
│              │                                              │
│   SIDEBAR    │                   MAP                        │
│   (detail /  │                                              │
│   compare /  │                                              │
│   history)   │                                              │
│              │                                              │
└──────────────┴──────────────────────────────────────────────┘
```
- Sidebar slides in from left on marker click
- Three sidebar modes: **Detail**, **Compare**, **Price History** (tab-switched)
- Collapsed sidebar = full-width map

### Map Markers
- `L.circleMarker` — radius 8, stroke 1.5px
- Colors: `#22c55e` single-family, `#3b82f6` townhouse, `#f59e0b` condo, `#a855f7` semi
- Hover: radius expands to 11, white ring
- Active (selected): filled with white center dot

### Build Detail Sidebar
- Builder logo / community hero image
- Name, community, status badge (selling/upcoming/sold-out)
- Price in JetBrains Mono, large
- Models list: name, sqft, beds/baths, price
- "Compare with another" button → activates compare mode
- "Price History" tab → inline sparkline chart

---

## Model Comparison Feature

### Flow
1. User clicks a build → sidebar opens in Detail mode
2. User clicks "Compare" → sidebar switches to Compare mode, map shows a "pick another" tooltip
3. User clicks second build → side-by-side comparison renders in sidebar
4. "Clear comparison" button resets

### Compare View Layout (in sidebar)
```
┌────────────────┬────────────────┐
│  Build A       │  Build B       │
│  Mattamy       │  Claridge      │
├────────────────┼────────────────┤
│  $649K         │  $589K         │  ← prices highlighted, cheaper = green
│  Townhouse     │  Semi-detached │
│  1,650 sqft    │  1,800 sqft    │  ← larger = bold
│  3 bed / 2.5ba │  4 bed / 3ba   │
│  Kanata        │  Barrhaven     │
│  Selling       │  Upcoming      │
└────────────────┴────────────────┘
  [View A details] [View B details]
```

### `public/compare.js`
- Stores two selected build IDs in app state
- Renders comparison table with delta highlighting
- Comparison is shareable via URL hash: `#compare=build-a-id,build-b-id`

---

## Price History Feature

### `public/history.js`
- Loads `data/history/prices.json` on demand (lazy fetch)
- Renders a lightweight SVG sparkline (no chart library — drawn with raw SVG path)
- Shows: price trend line, date of each data point on hover, % change from first to latest
- "New releases" feed: reads `data/history/releases.json`, shows reverse-chronological list of events

### New Release Toasts
- On page load, check `releases.json` for events in the last 7 days
- Show stacked toast notifications: "New: Minto Central Park from $580K" (auto-dismiss 5s)

---

## Cloudflare Pages + Squarespace Hosting

### Cloudflare Pages Setup (manual, one-time)
1. Push repo to GitHub (`lizy1630/newbuildmap`)
2. Connect repo to Cloudflare Pages (free account, dashboard.cloudflare.com)
3. Build settings: build command = none, output directory = `public`
4. Cloudflare serves `public/` as a static site at `https://newbuildmap.pages.dev`

### GitHub Actions auto-deploy
- Every day: scraper runs → JSON files updated → committed to `main` → Cloudflare Pages deploys automatically

### Squarespace Embed
In Squarespace: Insert Block → Embed → paste:
```html
<iframe
  src="https://newbuildmap.pages.dev"
  style="width:100%;height:700px;border:none;border-radius:0;"
  loading="lazy"
  title="Ottawa New Build Map">
</iframe>
```
- iframe works on Squarespace Business plan and above (Custom Code block)
- Cloudflare sets correct CORS headers for cross-origin iframe by default

---

## Implementation Order

### Phase 1 (core map)
1. `package.json` + `npm install axios cheerio` + `.gitignore`
2. `scraper/utils.js`, `scraper/geocode.js`
3. `scraper/sources/claridge.js` (first scraper, static site)
4. `scraper/index.js` (Claridge only) → verify `data/builds.json`
5. `public/index.html` + `style.css` (dark theme, CSS vars)
6. `public/app.js` (map, markers, sidebar detail view)
7. `public/components/sidebar.js`, `filters.js`
8. Remaining scrapers: newinhomes, minto, mattamy, tartan
9. Full `npm run scrape` → verify merged output

### Phase 2 (history + comparison)
10. `scraper/history.js` — diff engine
11. `data/history/prices.json` + `data/history/releases.json` bootstrap
12. `public/history.js` — sparkline charts
13. `public/compare.js` — model comparison
14. `public/components/toast.js` — new release toasts

### Deployment
15. `.github/workflows/scrape.yml` — scheduled scraper
16. Push to `main` → connect to Cloudflare Pages
17. Verify iframe embed in Squarespace

---

## Verification

```bash
# Phase 1
npm install
npm run scrape         # → data/builds.json with 20+ builds, lat/lng populated
http-server public -p 8080 -c-1
# → http://localhost:8080: map loads, markers visible, click → sidebar with details
# → filters work, count label updates

# Phase 2
npm run scrape         # run twice → history/prices.json shows 2 snapshots
# → price history tab shows sparkline
# → compare: click 2 builds → side-by-side table appears, deltas highlighted

# Hosting
# Push to GitHub → Cloudflare Pages deploys → verify https://newbuildmap.pages.dev loads
# Paste iframe in Squarespace embed block → verify map loads inside Squarespace page
```

---

## Key Notes

- **No API keys** anywhere — Leaflet, OSM tiles, Nominatim, Cloudflare Pages all free
- **CartoDB tiles** (free): `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`
- **SVG sparklines** drawn without a chart library (path element from price array → reduces payload)
- **URL-shareable comparisons** via `#compare=id1,id2` hash — works in iframes too
- **Nominatim cache** persisted to `data/raw/geocode-cache.json` — survives between GitHub Actions runs if committed
- **Scraper fragility**: each source logs raw HTML snippet when zero results found; `data/raw/` cache allows re-running without re-fetching
