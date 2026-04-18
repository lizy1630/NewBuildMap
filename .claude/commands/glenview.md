# Glenview Homes Scraper

Scrapes Glenview Homes Ottawa communities from glenviewhomes.com.

**Communities:**
- **Ironwood** — Riverside South (38' + 34' Lot Collections, single-family)
- **The Commons** — Orléans (back-to-back townhomes + executive townhomes + 30'/36' lots)
- **Union West** — Stittsville (townhomes + 30'/36' lots)
- **Wateridge Village** — Ottawa East (coming soon, no floor plans yet)

**Category hierarchy:**
- Level 1: Single Family | Townhomes
- Level 3: "34' Lot Collection", "38' Lot Collection", "Back-to-Back Townhome Collection", etc.

**To run just Glenview:**
```bash
cd /Users/xingsbot/NewBuildMap && node --input-type=module -e "
import { scrape } from './scraper/sources/glenview.js';
scrape().then(b => console.log(b.map(x => x.name + ': ' + x.models.length + ' models').join('\n')));
"
```

**To run full scraper:**
```bash
cd /Users/xingsbot/NewBuildMap && node scraper/index.js
```

**Source file:** `scraper/sources/glenview.js`
**Price reports:** `public/data/glenview-price-reports/`
**Images:** `public/images/glenview/`
