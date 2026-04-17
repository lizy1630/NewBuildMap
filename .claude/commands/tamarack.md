# Tamarack Homes Scraper

Runs the Tamarack Homes scraper to update community data from tamarackhomes.com.

**What it does:**
1. Fetches the /inventory/ page and parses the inline `propertiesData` JSON
2. Filters to Ottawa communities (Cardinal Creek Village, Findlay Creek Village, Idylea, The Meadows, Westwood)
3. Deduplicates models (move-in-ready + under-construction → one entry with lowest price)
4. Downloads model images to `/public/images/tamarack/`
5. Writes price reports to `/public/data/tamarack-price-reports/`
6. Returns community builds to be merged into builds.json

**To run just Tamarack:**

```bash
cd /Users/xingsbot/NewBuildMap && node -e "
import('./scraper/sources/tamarack.js').then(m => m.scrape()).then(builds => {
  console.log(JSON.stringify(builds, null, 2));
}).catch(console.error);
"
```

**To run full scraper (all builders including Tamarack):**

```bash
cd /Users/xingsbot/NewBuildMap && node scraper/index.js
```

**Source file:** `scraper/sources/tamarack.js`
**Feature sheets:** `public/data/tamarack-price-reports/tamarack-towns-feature-sheet.pdf` and `tamarack-singles-feature-sheet.pdf`
