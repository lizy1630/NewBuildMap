/**
 * Scraper for Mattamy Homes — mattamyhomes.com
 * Ottawa communities: Half Moon Bay, Locale, Northwoods, Richmond Meadows,
 *                     Traditions II, Wateridge Village at Rockcliffe
 *
 * Site is React/Next.js; Playwright required.
 * Search URL: /search?community=<NAME>&country=CAN&metro=Ottawa&productType=plan
 * Plan cards: #ProductInfo elements
 * Community filter in URL may return all Ottawa plans for some communities;
 * fall back to filtering by urlSlug in plan href.
 * taxIncluded = true (prices include HST, set by orchestrator)
 */
import { chromium } from 'playwright-core';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import axios from 'axios';
import { formatPrice, slugify, sleep } from '../utils.js';

const BASE_URL    = 'https://www.mattamyhomes.com';
const REPORTS_DIR = new URL('../../public/data/mattamy-price-reports', import.meta.url).pathname;
const IMAGES_DIR  = new URL('../../public/images/mattamy', import.meta.url).pathname;

// ── Known communities ──────────────────────────────────────────────────────────
// Hardcoded coords — Nominatim returns 403 from scraper context
const KNOWN_COMMUNITIES = [
  {
    id: 'mattamy-half-moon-bay',
    displayName: 'Half Moon Bay',
    searchName: 'Half Moon Bay',
    urlSlug: 'half-moon-bay',
    neighbourhood: 'Barrhaven',
    lat: 45.2474, lng: -75.7393,
  },
  {
    id: 'mattamy-locale',
    displayName: 'Locale',
    searchName: 'Locale',
    urlSlug: 'locale',
    neighbourhood: 'Orléans',
    lat: 45.4650, lng: -75.5140,
  },
  {
    id: 'mattamy-northwoods',
    displayName: 'Northwoods',
    searchName: 'Northwoods',
    urlSlug: 'northwoods',
    neighbourhood: 'Kanata',
    lat: 45.3050, lng: -75.9080,
  },
  {
    id: 'mattamy-richmond-meadows',
    displayName: 'Richmond Meadows',
    searchName: 'Richmond Meadows',
    urlSlug: 'richmond-meadows',
    neighbourhood: 'Richmond',
    lat: 45.1950, lng: -75.8270,
  },
  {
    id: 'mattamy-traditions-ii',
    displayName: 'Traditions II',
    searchName: 'Traditions II',
    urlSlug: 'traditions-ii',
    neighbourhood: 'Stittsville',
    lat: 45.2550, lng: -75.9350,
  },
  {
    id: 'mattamy-wateridge-village',
    displayName: 'Wateridge Village at Rockcliffe',
    searchName: 'Wateridge Village at Rockcliffe',
    urlSlug: 'wateridge',
    neighbourhood: 'Rockcliffe Park',
    lat: 45.4270, lng: -75.6540,
  },
];

// ── Type normalization ─────────────────────────────────────────────────────────

function normalizeType(raw) {
  const s = (raw || '').toLowerCase();
  if (s.includes('semi')) return 'Semi-Detached';
  if (s.includes('townhome') || s.includes('townhouse')) return 'Townhomes';
  if (s.includes('attached') && !s.includes('detached')) return 'Townhomes';
  if (s.includes('condominium') || s.includes('condo') || s.includes('flat')) return 'Condo';
  if (s.includes('detached') || s.includes('single')) return 'Single Family';
  return 'Single Family';
}

function typesToMapType(types) {
  const has = t => types.some(x => x.toLowerCase().includes(t.toLowerCase()));
  if (has('Condo')) return 'condo';
  if ((has('Single Family') || has('Semi')) && has('Town')) return 'mixed';
  if (has('Town') || has('Semi')) return 'townhouse';
  return 'single-family';
}

// ── Image download ─────────────────────────────────────────────────────────────

async function downloadImage(remoteUrl, communitySlug, modelName) {
  if (!remoteUrl) return null;
  mkdirSync(`${IMAGES_DIR}/${communitySlug}`, { recursive: true });
  const rawExt  = remoteUrl.split('.').pop().split('?')[0].toLowerCase();
  const ext     = ['jpg', 'jpeg', 'png', 'webp'].includes(rawExt) ? rawExt : 'jpg';
  const filename = `${slugify(modelName)}.${ext}`;
  const dest    = `${IMAGES_DIR}/${communitySlug}/${filename}`;
  const pubPath = `/images/mattamy/${communitySlug}/${filename}`;
  if (existsSync(dest)) return pubPath;
  try {
    const res = await axios.get(remoteUrl, {
      responseType: 'stream', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    await new Promise((resolve, reject) => {
      const w = createWriteStream(dest);
      res.data.pipe(w);
      w.on('finish', resolve);
      w.on('error', reject);
    });
    return pubPath;
  } catch {
    return remoteUrl; // fallback to remote URL
  }
}

// ── PDF price report ───────────────────────────────────────────────────────────

async function generatePriceReport(browser, communityName, models, date) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const safeDate = date.slice(0, 10); // date only — one PDF per community per day
  const filename = `${slugify(communityName)}-${safeDate}.pdf`;
  const outPath  = `${REPORTS_DIR}/${filename}`;
  if (existsSync(outPath)) return `/data/mattamy-price-reports/${filename}`;

  const rows = models.map(m => `
    <tr class="${m.available === false ? 'sold' : ''}">
      <td>${m.type || '—'}</td>
      <td>${m.localImageUrl ? `<img src="${m.localImageUrl}" width="80" height="60" style="object-fit:cover;border-radius:3px">` : ''}</td>
      <td>${m.name}</td>
      <td>${m.sqft ? m.sqft.toLocaleString() + ' sqft' : '—'}</td>
      <td>${m.beds ?? '—'} bd / ${m.baths ?? '—'} ba</td>
      <td>${m.priceFrom ? '$' + m.priceFrom.toLocaleString('en-CA') : '—'}</td>
      <td>${m.available === false ? 'Sold Out' : 'Available'}</td>
    </tr>`
  ).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 11px; margin: 20px; }
  h1 { font-size: 16px; margin-bottom: 4px; }
  .meta { color: #666; font-size: 10px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #c8102e; color: #fff; padding: 6px 8px; text-align: left; font-size: 10px; }
  td { padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: middle; }
  tr.sold td { color: #aaa; text-decoration: line-through; }
  tr:nth-child(even) td { background: #fafafa; }
</style>
</head>
<body>
<h1>Mattamy Homes – ${communityName} | Price Report</h1>
<div class="meta">Generated: ${date} | Data from mattamyhomes.com</div>
<table>
  <thead><tr><th>Type</th><th>Image</th><th>Plan</th><th>Size</th><th>Beds/Baths</th><th>Price</th><th>Status</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body>
</html>`;

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: outPath, format: 'A4', printBackground: true,
    margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
  await page.close();
  console.log(`  [mattamy] PDF saved: ${filename}`);
  return `/data/mattamy-price-reports/${filename}`;
}

// ── Parse bath count from spec text ───────────────────────────────────────────

function parseBaths(specText) {
  const halfM = specText.match(/(\d+)\s*Half\s*Bath/i);
  const halfBaths = halfM ? parseInt(halfM[1]) : 0;
  // Remove "Half Bath" fragment before matching full baths
  const noHalf = specText.replace(/\d+\s*Half\s*Baths?/gi, '');
  const fullM = noHalf.match(/(\d+)\s*Baths?/i);
  const fullBaths = fullM ? parseInt(fullM[1]) : 0;
  const total = fullBaths + halfBaths * 0.5;
  return total > 0 ? total : null;
}

// ── Scrape search results for one community ────────────────────────────────────

async function scrapeSearchPage(browser, comm) {
  const searchUrl = `${BASE_URL}/search?community=${encodeURIComponent(comm.searchName)}&country=CAN&hideMap=true&homeType=All&metro=Ottawa&productType=plan`;
  console.log(`  → ${searchUrl}`);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 45000 });
    await sleep(2500);
    await page.waitForSelector('#ProductInfo', { timeout: 12000 }).catch(() => {});

    const rawPlans = await page.evaluate((urlSlug) => {
      const cards = [...document.querySelectorAll('#ProductInfo')];
      return cards.map(card => {
        // Plan link — must contain /ontario/ottawa/ path
        const link = card.querySelector('a[href*="/ontario/ottawa/"]');
        const href = link ? (link.href || link.getAttribute('href') || '') : '';

        // Filter by community slug in path
        if (urlSlug && !href.toLowerCase().includes(urlSlug.toLowerCase())) return null;

        // Name
        const name = card.querySelector('h3')?.textContent?.trim() || '';
        if (!name) return null;

        // Home type — first element whose text starts with a known type keyword
        const typeEl = [...card.querySelectorAll('div, p, span')].find(el => {
          const t = el.textContent.trim();
          return /^(condominium|townhome|townhouse|detached|semi-detached|attached)/i.test(t) && t.length < 60;
        });
        const type = typeEl?.textContent?.trim() || '';

        // Spec text — prefer [type="Plan"] element, fall back to full card text
        const specEl = card.querySelector('[type="Plan"]') ||
                       card.querySelector('[class*="spec" i]') ||
                       card.querySelector('[class*="Stat" i]');
        const specText = (specEl || card).textContent || '';

        // Beds
        const bedsM = specText.match(/(\d+)\s*Beds?/i);
        const beds = bedsM ? parseInt(bedsM[1]) : null;

        // Sqft
        const sqftM = specText.match(/([\d,]+)\s*Sq\.?\s*Ft/i);
        const sqft = sqftM ? parseInt(sqftM[1].replace(/,/g, '')) : null;

        // Price — first $ amount in the card
        const cardText = card.textContent;
        const priceM = cardText.match(/\$([\d,]+)/);
        const priceFrom = priceM ? parseInt(priceM[1].replace(/,/g, '')) : null;

        // Sold out
        const available = !/sold[\s-]?out/i.test(cardText);

        // Image — lives in a sibling div (card is split: left=image, right=#ProductInfo)
        const cardContainer = card.parentElement;
        const imgEl = cardContainer?.querySelector('img') || card.querySelector('img');
        const imageUrl = imgEl?.src || imgEl?.currentSrc || imgEl?.getAttribute('src') || '';

        // Source URL (community page — strip everything after community slug)
        let sourceUrl = href.startsWith('http') ? href : `https://www.mattamyhomes.com${href}`;

        // Bath data — raw text for post-processing
        const bathText = specText;

        return { name, type, beds, sqft, priceFrom, available, imageUrl, sourceUrl, href, bathText };
      }).filter(Boolean);
    }, comm.urlSlug);

    await context.close();
    return rawPlans;
  } catch (err) {
    await context.close();
    throw err;
  }
}

// ── Derive community source URL from a plan URL ────────────────────────────────

function communityUrl(planHref, urlSlug) {
  if (!planHref) return `${BASE_URL}/ontario/ottawa/`;
  // Plan URL: /ontario/ottawa/<neighbourhood>/<slug>/plans/<plan>/
  // Community: /ontario/ottawa/<neighbourhood>/<slug>/
  const m = planHref.match(/(https?:\/\/[^/]+\/ontario\/ottawa\/[^/]+\/[^/]+)\//);
  return m ? m[1] + '/' : planHref;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function scrape() {
  console.log('[mattamy] Starting Ottawa scrape...');
  const browser = await chromium.launch({ headless: true });
  const builds   = [];
  const date     = new Date().toISOString();

  try {
    for (const comm of KNOWN_COMMUNITIES) {
      console.log(`\n[mattamy] ${comm.displayName}`);

      let rawPlans;
      try {
        rawPlans = await scrapeSearchPage(browser, comm);
      } catch (err) {
        console.warn(`  ✗ Failed to scrape: ${err.message}`);
        continue;
      }

      if (!rawPlans.length) {
        console.warn(`  ✗ No plans found (urlSlug filter: "${comm.urlSlug}")`);
        continue;
      }

      console.log(`  Found ${rawPlans.length} plans`);

      // Download images + parse baths + normalize type
      const models = [];
      for (const p of rawPlans) {
        const type  = normalizeType(p.type);
        const baths = parseBaths(p.bathText || '');
        const commSlug = slugify(comm.displayName);

        let localImageUrl = null;
        if (p.imageUrl) {
          localImageUrl = await downloadImage(p.imageUrl, commSlug, p.name);
          await sleep(60);
        }

        // Derive clean model source URL from plan href
        const modelUrl = p.sourceUrl;

        models.push({
          name:          p.name,
          type,
          sqft:          p.sqft,
          beds:          p.beds,
          baths,
          garages:       null,
          lotWidth:      null,
          priceFrom:     p.priceFrom,
          available:     p.available,
          localImageUrl,
          modelUrl,
        });
      }

      // Build typePrices — group by type, min available price per type
      const typeMap = {};
      for (const m of models) {
        if (!typeMap[m.type]) typeMap[m.type] = [];
        typeMap[m.type].push(m.priceFrom);
      }
      const typePrices = Object.entries(typeMap)
        .map(([type, prices]) => {
          const valid = prices.filter(Boolean);
          const p = valid.length ? Math.min(...valid) : null;
          return p ? { type, priceFrom: p, priceFromFormatted: formatPrice(p) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.priceFrom - b.priceFrom);

      const allPrices  = typePrices.map(t => t.priceFrom);
      const priceFrom  = allPrices.length ? Math.min(...allPrices) : null;
      const homeTypes  = [...new Set(models.map(m => m.type))];
      const sourceUrl  = communityUrl(rawPlans[0]?.href, comm.urlSlug);

      // Generate PDF
      let priceReportUrl = null;
      try {
        priceReportUrl = await generatePriceReport(browser, comm.displayName, models, date);
      } catch (err) {
        console.warn(`  [mattamy] PDF failed: ${err.message}`);
      }

      builds.push({
        id:                  comm.id,
        name:                comm.displayName,
        builder:             'Mattamy Homes',
        community:           comm.neighbourhood,
        address:             `${comm.displayName}, ${comm.neighbourhood}, Ottawa, ON`,
        lat:                 comm.lat,
        lng:                 comm.lng,
        homeTypes,
        type:                typesToMapType(homeTypes),
        models,
        typePrices,
        priceFrom,
        priceFromFormatted:  formatPrice(priceFrom),
        taxIncluded:         true,
        featureSheets:       [],
        includedFeatures:    [],
        priceReportUrl,
        status:              'selling',
        completionYear:      null,
        description:         `A Mattamy Homes community in ${comm.neighbourhood}, Ottawa.`,
        sourceUrl,
        sourceName:          'mattamyhomes.com',
        imageUrl:            '',
        scrapedAt:           date,
      });

      console.log(`  ✓ ${models.length} plans | typePrices: ${typePrices.map(t => `${t.type} ${t.priceFromFormatted}`).join(', ')}`);
      await sleep(1500);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n[mattamy] Done — ${builds.length} communities`);
  return builds;
}
