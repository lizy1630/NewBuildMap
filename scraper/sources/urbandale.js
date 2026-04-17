/**
 * Scraper for Urbandale Homes Ottawa — urbandale.com
 *
 * Scrapes all active communities discovered from /communities-[slug]/
 * Two scraping passes per community:
 *   1. Category pages (?property-type=X&location=Y) → plan models (no prices)
 *   2. Location page (?location=Y&post_type=home-details) → inventory homes (with prices)
 *
 * Plan model cards use <div> children; model name from image alt text (Series Model → Model).
 * Inventory home cards use <p>/<h3> children; model name in <h3>; price in <p>$ X</p>.
 *
 * Name rules:
 *   Unit type "Interior Unit" → drop (use base model name)
 *   Unit type "End Unit"      → append " End"
 *
 * Lot width: fetched from detail page a[href*="/lotsize/"]  (singles/bungalows only)
 * Garages:   inferred from type (townhome/urban-town → 1, singles/bungalows → 2)
 * taxIncluded = false
 *
 * PDF price report generated per community only when inventory home prices are found.
 */
import { chromium } from 'playwright-core';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatPrice, slugify, sleep } from '../utils.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '../../');
const IMAGES_DIR = path.join(ROOT, 'public/images/urbandale');
const REPORTS_DIR = path.join(ROOT, 'public/data/urbandale-price-reports');

mkdirSync(IMAGES_DIR, { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

// ── Community metadata ─────────────────────────────────────────────────────────
// lat/lng hardcoded for known communities; null = geocoder handles
const COMMUNITY_META = {
  'riverside-south': { neighbourhood: 'Riverside South', address: 'Riverside South, Ottawa, ON',          lat: 45.2650,  lng: -75.6852  },
  'kanata-lakes':    { neighbourhood: 'Kanata Lakes',    address: 'Kanata Lakes, Kanata, ON',              lat: 45.3127,  lng: -75.9119  },
  'bradley-commons': { neighbourhood: 'Stittsville',     address: '560 Hazeldean Road, Stittsville, ON',   lat: 45.2892,  lng: -75.9005  },
  'leitrim-flats':   { neighbourhood: 'Leitrim',         address: '4793 Bank Street, Ottawa, ON',          lat: 45.3193,  lng: -75.5926  },
  'the-creek':       { neighbourhood: 'Kemptville',      address: 'Bristol Street, Kemptville, ON',        lat: 45.0301,  lng: -75.6420  },
  'cowans-grove':    { neighbourhood: "Cowan's Grove",   address: '138 Shuttleworth Drive, Ottawa, ON',    lat: 45.3182,  lng: -75.5904  },
};

// ── Name normalization ─────────────────────────────────────────────────────────

function normalizeModelName(modelName, unitType) {
  const unit = (unitType || '').toLowerCase();
  if (/end\s+unit/i.test(unit)) {
    return modelName.trim() + ' End';
  }
  // Interior → just model name (drop Interior)
  return modelName.trim();
}

// ── Lot width parsing from href ────────────────────────────────────────────────

function parseLotFromHref(href) {
  // /lotsize/35-ft/ → 35   OR  /lotsize/35/  → 35
  const m = href.match(/\/lotsize\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Normalize type names (inventory pages sometimes use singular)
function normalizeTypeName(t) {
  if (!t) return t;
  if (/^townhome$/i.test(t.trim())) return 'Townhomes';
  if (/^urban\s+town$/i.test(t.trim())) return 'Urban Towns';
  if (/^bungalow$/i.test(t.trim())) return 'Bungalows';
  if (/^single$/i.test(t.trim())) return 'Singles & Bungalows';
  if (/^condo$/i.test(t.trim())) return 'Condos';
  return t.trim();
}

function inferGarages(typeName) {
  if (/town|urban|condo/i.test(typeName)) return 1;
  return 2; // singles, bungalows
}

// ── Image download ─────────────────────────────────────────────────────────────

async function downloadImage(url, commSlug, modelSlug) {
  if (!url) return null;
  const commDir = path.join(IMAGES_DIR, commSlug);
  mkdirSync(commDir, { recursive: true });

  const rawExt = (url.split('.').pop().split('?')[0] || 'jpg').toLowerCase();
  const ext    = ['jpg', 'jpeg', 'png', 'webp'].includes(rawExt) ? rawExt : 'jpg';
  const dest   = path.join(commDir, `${modelSlug}.${ext}`);
  const pub    = `/images/urbandale/${commSlug}/${modelSlug}.${ext}`;

  if (existsSync(dest)) return pub;
  try {
    const res = await axios.get(url, {
      responseType: 'stream', timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
    });
    await new Promise((resolve, reject) => {
      const w = createWriteStream(dest);
      res.data.pipe(w);
      w.on('finish', resolve);
      w.on('error', reject);
    });
    return pub;
  } catch {
    return url; // fallback to remote
  }
}

// ── Parse cards from a listing page ───────────────────────────────────────────
// Cards are <li class="fusion-layout-column"> inside <ul class="fusion-grid">
// Plan models: lines[0] = series name (e.g. "Horizon"), lines[1] = model name
// Inventory homes: lines[0] = "Interior Unit" or "End Unit", lines[1] = model name

async function parseListingPage(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('ul.fusion-grid');
    if (!grid) return [];

    const liCards = Array.from(grid.querySelectorAll('li[class*="fusion-layout-column"]'));

    return liCards.map(li => {
      const link = li.querySelector('a[href*="/home-details/"]');
      if (!link) return null;

      const img  = li.querySelector('img');
      const raw  = li.textContent.trim();
      // Normalize whitespace per line
      const lines = raw.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (lines.length < 2) return null;

      const firstLine = lines[0];
      const isInventory = /^(interior|end)\s+unit$/i.test(firstLine);

      let modelName = '', series = '', unitType = '';
      if (isInventory) {
        unitType  = firstLine;  // "Interior Unit" or "End Unit"
        modelName = lines[1] || '';
      } else {
        series    = firstLine;  // e.g. "Horizon"
        modelName = lines[1] || '';
      }

      // Beds: "3 Beds・" or "3 or 4 Beds・" or "4 or 5 Beds・"
      let bedsMin = null, bedsMax = null;
      for (const line of lines) {
        const m = line.match(/^(\d+)(?:\s+or\s+(\d+))?\s+Beds/i);
        if (m) { bedsMin = parseInt(m[1]); if (m[2]) bedsMax = parseInt(m[2]); break; }
      }

      // Baths: "2.5 Baths・" or "2.5 or 3 or 3.5 Baths・"
      let baths = null;
      for (const line of lines) {
        const m = line.match(/^([\d.]+)(?:\s+or\s+[\d.]+)*\s+Baths/i);
        if (m) { baths = parseFloat(m[1]); break; }
      }

      // Sqft
      let sqft = null;
      for (const line of lines) {
        const m = line.match(/^([\d,]+)\s+sq\s*ft/i);
        if (m) { sqft = parseInt(m[1].replace(/,/g, '')); break; }
      }

      // Type: first line that's not series/unit/model/badge/beds/baths/sqft/location
      let typeName = '';
      for (let i = 2; i < lines.length; i++) {
        const l = lines[i];
        if (/net zero|energy star|SAVE|\d+\s+Beds|\d+.*Baths|sq\s*ft|\$|Ottawa/i.test(l)) continue;
        typeName = l; break;
      }

      // Price: "$ 649,900"
      let price = null;
      for (const line of lines) {
        const m = line.replace(/,/g, '').match(/^\$\s*([\d]+)$/);
        if (m) { const v = parseInt(m[1]); if (v > 100000) { price = v; break; } }
      }

      // Address
      let address = '';
      for (const line of lines) {
        if (/^\d+\s+\w.*(Street|Avenue|Way|Drive|Lane|Court|Place|Road|Crescent|Grove|Blvd)/i.test(line)) {
          address = line; break;
        }
      }

      return {
        href:        link.href,
        imageUrl:    img?.src || '',
        imgAlt:      img?.alt?.trim() || '',
        modelName,
        series,
        unitType,
        isInventory,
        bedsMin,
        bedsMax,
        baths,
        sqft,
        typeName,
        price,
        address,
      };
    }).filter(Boolean).filter(c => c.href && c.modelName);
  });
}

// ── Load all pages of a listing (pagination) ───────────────────────────────────

async function scrapeAllPages(page, startUrl) {
  const allCards = [];
  let url = startUrl;

  // Normalize to page 1 (remove /page/N/ if present)
  url = url.replace(/\/page\/\d+\//, '/');

  while (url) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000);

    const cards = await parseListingPage(page);
    allCards.push(...cards);

    // Check for next page link
    const nextUrl = await page.evaluate(() => {
      const next = document.querySelector('a.next, a[rel="next"], .pagination .next a, nav.pagination a[aria-label*="Next"]');
      return next?.href || null;
    });
    url = nextUrl || null;
  }

  return allCards;
}

// ── Fetch lot width from model detail page ─────────────────────────────────────

async function fetchLotWidth(page, href) {
  try {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const lotHref = await page.evaluate(() => {
      const el = document.querySelector('a[href*="/lotsize/"]');
      return el?.href || '';
    });
    return parseLotFromHref(lotHref);
  } catch {
    return null;
  }
}

// ── PDF price report ───────────────────────────────────────────────────────────

async function generatePriceReport(browser, commSlug, commName, typeGroups, date) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const safeDate = date.replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${commSlug}-${safeDate}.pdf`;
  const outPath  = path.join(REPORTS_DIR, filename);
  const pubPath  = `/data/urbandale-price-reports/${filename}`;
  if (existsSync(outPath)) return pubPath;

  const sectionsHtml = typeGroups.map(({ typeName, models }) => {
    const priced = models.filter(m => m.priceFrom).map(m => m.priceFrom);
    const fromPrice = priced.length ? Math.min(...priced) : null;

    const rows = models.map(m => {
      const imgHtml = m.localImageUrl
        ? `<img src="${ROOT}/public${m.localImageUrl}" width="80" height="55" style="object-fit:cover;border-radius:3px">`
        : '<span style="color:#ccc;font-size:9px">No image</span>';
      const priceHtml = m.priceFrom
        ? `<strong>$${m.priceFrom.toLocaleString('en-CA')}</strong>`
        : '—';
      return `<tr>
        <td>${imgHtml}</td>
        <td><strong>${m.name}</strong>${m.address ? `<br><span style="font-size:8px;color:#888">${m.address}</span>` : ''}</td>
        <td>${m.sqft ? m.sqft.toLocaleString() + ' sq.ft.' : '—'}</td>
        <td>${m.beds ?? '—'} bd / ${m.baths ?? '—'} ba</td>
        <td>${m.garages ?? '—'} gar${m.lotWidth ? ` / ${m.lotWidth}′ lot` : ''}</td>
        <td>${priceHtml}</td>
      </tr>`;
    }).join('');

    return `<div class="section">
      <div class="section-header">
        <span class="section-name">${typeName}</span>
        ${fromPrice ? `<span class="from-price">From $${fromPrice.toLocaleString('en-CA')}</span>` : ''}
      </div>
      <table>
        <thead><tr><th>Image</th><th>Model</th><th>Size</th><th>Beds/Baths</th><th>Gar/Lot</th><th>Price</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; margin: 0; padding: 20px; color: #1a1a1a; }
  h1 { font-size: 15px; font-weight: 700; margin: 0 0 2px; color: #2c5282; }
  .meta { font-size: 9px; color: #888; margin-bottom: 18px; }
  .section { margin-bottom: 18px; page-break-inside: avoid; }
  .section-header { display: flex; align-items: baseline; gap: 14px; margin-bottom: 5px; border-bottom: 2px solid #2c5282; padding-bottom: 3px; }
  .section-name { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #2c5282; }
  .from-price { font-size: 10px; font-weight: 600; color: #333; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #2c5282; color: #fff; padding: 5px 8px; text-align: left; font-size: 9px; font-weight: 600; text-transform: uppercase; }
  td { padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: middle; }
  tr:nth-child(even) td { background: #fafafa; }
  td:last-child { font-weight: 600; }
</style></head><body>
<h1>Urbandale – ${commName} | Price Report</h1>
<div class="meta">Generated: ${date} · Source: urbandale.com · Prices exclude HST</div>
${sectionsHtml}
</body></html>`;

  const pg = await browser.newPage();
  await pg.setContent(html, { waitUntil: 'load' });
  await pg.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  await pg.close();
  console.log(`  [urbandale] PDF saved: ${filename}`);
  return pubPath;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function scrape() {
  console.log('[urbandale] Starting Urbandale scrape...');
  const browser = await chromium.launch({ headless: true });
  const date   = new Date().toISOString();
  const builds = [];

  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });

    // 1. Discover community slugs from communities page
    await page.goto('https://urbandale.com/communities/', { waitUntil: 'networkidle', timeout: 30000 });
    const communityUrls = await page.evaluate(() => {
      const seen = new Set();
      return Array.from(document.querySelectorAll('a[href*="/communities-"]'))
        .map(a => a.href)
        .filter(h => /\/communities-[a-z][a-z0-9-]+\/$/.test(h))
        .filter(h => { if (seen.has(h)) return false; seen.add(h); return true; });
    });

    console.log(`[urbandale] Found ${communityUrls.length} communities`);

    for (const commUrl of communityUrls) {
      const slugMatch = commUrl.match(/\/communities-([a-z0-9-]+)\//);
      if (!slugMatch) continue;
      const commSlug = slugMatch[1];
      const meta     = COMMUNITY_META[commSlug] || { neighbourhood: null, address: null, lat: null, lng: null };

      // 2. Load community page → get h2 name + category links
      await page.goto(commUrl, { waitUntil: 'networkidle', timeout: 30000 });
      const { commName, categoryLinks } = await page.evaluate(() => {
        // Community name from first prominent h2
        const h2 = document.querySelector('h2');
        const rawName = h2?.textContent?.trim() || '';
        const commName = rawName
          .split(' ')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ');

        // Category links — Avada Fusion Builder uses fusion-column-anchor
        const links = Array.from(document.querySelectorAll('a.fusion-column-anchor[href*="property-type"]')).map(a => {
          // Label from nearest sibling fusion-text div
          const col = a.closest('[class*="fusion-layout-column"]');
          const label = col?.querySelector('.fusion-text p, .fusion-text h3')?.textContent?.trim() || '';
          return { href: a.href, label };
        });

        return { commName, categoryLinks: links };
      });

      const displayName = commName || meta.neighbourhood || slugMatch[1].split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      console.log(`\n[urbandale] ${displayName} (${meta.neighbourhood || commSlug})`);

      if (!categoryLinks.length) {
        console.log('  [urbandale] No category links — skipping');
        continue;
      }

      // 3. Scrape plan models from each category page
      const planModels = new Map(); // normalized name → model entry
      const typeLabelMap = {};      // normalized name → type label

      const detailPage = await browser.newPage();
      await detailPage.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });

      for (const cat of categoryLinks) {
        const typeName = cat.label || 'Unknown';
        console.log(`  [urbandale] Category: ${typeName}`);
        const cards = await scrapeAllPages(page, cat.href);

        for (const card of cards) {
          if (card.isInventory) continue; // handle inventory separately
          const name = normalizeModelName(card.modelName, card.unitType);
          if (!name || planModels.has(name)) continue; // dedup plans

          const beds    = card.bedsMax != null ? `${card.bedsMin} (opt ${card.bedsMax})` : card.bedsMin;
          const baths   = card.baths;
          const garages = inferGarages(typeName);

          // Fetch lot width from detail page (singles/bungalows only)
          let lotWidth = null;
          if (/single|bungalow/i.test(typeName)) {
            lotWidth = await fetchLotWidth(detailPage, card.href);
            await sleep(300);
          }

          // Download image
          const modelSlug = slugify(name);
          const localImageUrl = await downloadImage(card.imageUrl, commSlug, modelSlug);
          await sleep(100);

          const model = {
            name,
            type:    typeName,
            sqft:    card.sqft,
            beds,
            baths,
            garages,
            lotWidth,
            priceFrom:  null,
            available:  true,
            localImageUrl,
            modelUrl: card.href,
          };
          planModels.set(name, model);
          typeLabelMap[name] = typeName;
        }
        await sleep(400);
      }

      // 4. Scrape inventory homes from location-only page
      const inventoryUrl = `https://urbandale.com/homes/?location=${commSlug}&post_type=home-details`;
      const inventoryCards = await scrapeAllPages(page, inventoryUrl);
      const inventoryHomes = [];

      for (const card of inventoryCards) {
        if (!card.isInventory) continue;
        const name  = normalizeModelName(card.modelName, card.unitType);
        const beds  = card.bedsMax != null ? `${card.bedsMin} (opt ${card.bedsMax})` : card.bedsMin;
        const baths = card.baths;

        // Infer type from card or existing plan model type
        let typeName = normalizeTypeName(card.typeName) || 'Singles & Bungalows';
        const matchingPlan = planModels.get(name) || planModels.get(card.modelName.trim());
        if (matchingPlan) typeName = matchingPlan.type;
        else if (/townhome|town/i.test(card.unitType)) typeName = 'Townhomes';

        const garages = inferGarages(typeName);

        // Lot width: use from plan model if available
        let lotWidth = matchingPlan?.lotWidth ?? null;
        if (!lotWidth && /single|bungalow/i.test(typeName)) {
          lotWidth = await fetchLotWidth(detailPage, card.href);
          await sleep(300);
        }

        // Update plan model's priceFrom with this inventory price
        if (matchingPlan && card.price) {
          if (!matchingPlan.priceFrom || card.price < matchingPlan.priceFrom) {
            matchingPlan.priceFrom = card.price;
          }
          // Update lot width on plan if not set
          if (!matchingPlan.lotWidth && lotWidth) matchingPlan.lotWidth = lotWidth;
        }

        // If no matching plan model, create a standalone inventory entry
        if (!matchingPlan) {
          const modelSlug     = slugify(name + (card.address ? '-' + card.address.match(/^\d+/)?.[0] : ''));
          const localImageUrl = await downloadImage(card.imageUrl, commSlug, modelSlug);
          await sleep(100);

          inventoryHomes.push({
            name,
            type:           typeName,
            sqft:           card.sqft,
            beds,
            baths,
            garages,
            lotWidth,
            priceFrom:      card.price,
            available:      true,
            address:        card.address,
            localImageUrl,
            modelUrl:       card.href,
          });
        }
      }

      await detailPage.close();

      // 5. Assemble final model list
      const allModels = [...planModels.values(), ...inventoryHomes];

      // 6. Build typePrices
      const typeMap = {};
      for (const m of allModels) {
        if (!typeMap[m.type]) typeMap[m.type] = [];
        if (m.priceFrom) typeMap[m.type].push(m.priceFrom);
      }
      const typePrices = Object.entries(typeMap).map(([type, prices]) => ({
        type,
        priceFrom:           prices.length ? Math.min(...prices) : null,
        priceFromFormatted:  prices.length ? formatPrice(Math.min(...prices)) : 'Not available',
      }));

      const allPrices = allModels.map(m => m.priceFrom).filter(Boolean);
      const priceFrom = allPrices.length ? Math.min(...allPrices) : null;

      // 7. Generate PDF if any prices found
      let priceReportUrl = null;
      const pricedModels = allModels.filter(m => m.priceFrom);
      if (pricedModels.length > 0) {
        const typeGroups = Object.entries(typeMap).map(([typeName, _]) => ({
          typeName,
          models: allModels.filter(m => m.type === typeName && m.priceFrom),
        })).filter(g => g.models.length > 0);
        try {
          priceReportUrl = await generatePriceReport(browser, commSlug, displayName, typeGroups, date);
        } catch (err) {
          console.warn(`  [urbandale] PDF failed: ${err.message}`);
        }
      }

      // Determine map type
      const homeTypes  = [...new Set(allModels.map(m => m.type))];
      const hasSingle  = homeTypes.some(t => /single|bungalow/i.test(t));
      const hasTown    = homeTypes.some(t => /town/i.test(t));
      const mapType    = hasSingle && hasTown ? 'mixed' : hasTown ? 'townhouse' : 'single-family';

      builds.push({
        id:                 `urbandale-${commSlug}`,
        name:               displayName,
        builder:            'Urbandale',
        community:          meta.neighbourhood || displayName,
        address:            meta.address || `${displayName}, Ottawa, ON`,
        lat:                meta.lat,
        lng:                meta.lng,
        homeTypes,
        type:               mapType,
        models:             allModels,
        typePrices,
        priceFrom,
        priceFromFormatted: priceFrom ? formatPrice(priceFrom) : 'Not available',
        taxIncluded:        false,
        priceReportUrl,
        status:             'selling',
        sourceUrl:          commUrl,
        sourceName:         'urbandale.com',
        scrapedAt:          date,
      });

      console.log(`  ✓ ${displayName}: ${allModels.length} models, priceFrom: ${formatPrice(priceFrom)}`);
      typePrices.forEach(t => console.log(`    ${t.type}: ${t.priceFromFormatted}`));
      await sleep(600);
    }

    await page.close();
  } finally {
    await browser.close();
  }

  console.log(`\n[urbandale] Done — ${builds.length} communities`);
  return builds;
}
