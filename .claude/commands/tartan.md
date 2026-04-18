# Tartan Homes Scraper

Scrapes Tartan Homes Ottawa communities from tartanhomes.com.

**Communities (Ottawa only):**
- **Idylea** — Stittsville (community ID: 20234) · from ~$690k
- **Findlay Creek Village** — Findlay Creek (community ID: 133) · from ~$584k

**Level 3 categories:** Single Family · Bungalows · Semi-Detached · Townhomes · Early Occupancy

**Strategy:**
1. Fetch `/new-homes/` once — all 35 models in HTML, filtered by `community-XXXX` CSS class
2. Visit each model detail page to get per-community "Starting at" price from Bootstrap tab panes
3. Use lowest non-zero price across all models per community as `priceFrom`
4. GPS coords from `var thcm` embedded in community pages

**To run just Tartan:**
```bash
cd /Users/xingsbot/NewBuildMap && node --input-type=module -e "
import { scrape } from './scraper/sources/tartan.js';
scrape().then(b => b.forEach(x => console.log(x.name, x.priceFromFormatted, x.models.length + ' models')));
"
```

**To run full scraper:**
```bash
cd /Users/xingsbot/NewBuildMap && node scraper/index.js
```

**Source file:** `scraper/sources/tartan.js`
**Price reports:** `public/data/tartan-price-reports/`
**Images:** `public/images/tartan/`
