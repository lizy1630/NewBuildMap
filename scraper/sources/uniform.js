/**
 * Scraper for Uniform Developments — uniformdevelopments.com
 *
 * Auto-discovers communities from /communities/ page, skips:
 *   - coming-soon (Stinson Place)
 *   - sold-out (Maple Creek Estates, Kinver Private)
 *   - user-excluded (McNeely Landing — Carleton Place, outside Ottawa)
 *
 * Per community scrapes /community/<slug>/homes/ :
 *   - Clicks "Load More" (homesListing__pagination) until exhausted
 *   - Dismisses fancybox popup (Escape key) on first load
 *   - Parses .homesListing__item → name, type, lot width, sqft, beds, baths, garages, price, image
 *   - Downloads model images locally
 *   - Generates dated PDF price report per community (grouped by type)
 *
 * Home types: Bungalows | 2-Storey Singles | Townhomes | Horizon Towns
 * taxIncluded = false (prices are pre-HST)
 */
import { chromium } from 'playwright-core';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import axios from 'axios';
import { formatPrice, slugify, sleep } from '../utils.js';

const BASE_URL    = 'https://uniformdevelopments.com';
const REPORTS_DIR = new URL('../../public/data/uniform-price-reports', import.meta.url).pathname;
const IMAGES_DIR  = new URL('../../public/images/uniform', import.meta.url).pathname;

// ── Communities to skip (slug → reason) ─────────────────────────────────────
const SKIP_SLUGS = new Set([
  'maple-creek-estates',   // sold out
  'kinver-private',        // sold out
  'stinson-place',         // coming soon
  'mcneely-landing',       // Carleton Place — outside Ottawa scope
]);

// ── Hardcoded community metadata ─────────────────────────────────────────────
const COMMUNITY_META = {
  'copperwood-estate': {
    neighbourhood: 'Kanata',
    address: '2003 Bosch Place, Kanata, ON K2W 0N4',
    lat: 45.3450,
    lng: -75.9120,
  },
};

// ── Type normalization ────────────────────────────────────────────────────────

function normalizeType(raw) {
  const s = (raw || '').toLowerCase();
  if (s.includes('bungalow'))       return 'Bungalows';
  if (s.includes('2-storey') || s.includes('single')) return '2-Storey Singles';
  if (s.includes('horizon'))        return 'Horizon Towns';
  if (s.includes('town'))           return 'Townhomes';
  return raw?.trim() || 'Single Family';
}

function typeToMapType(types) {
  const has = t => types.some(x => x.toLowerCase().includes(t));
  if (has('town') || has('horizon')) {
    return (has('bungalow') || has('single')) ? 'mixed' : 'townhouse';
  }
  return 'single-family';
}

function typeToHomeType(type) {
  const s = type.toLowerCase();
  if (s.includes('town') || s.includes('horizon')) return 'Townhomes';
  return 'Single Family';
}

// ── Parse lot width from "36 ft. lot" ────────────────────────────────────────

function parseLotWidth(text) {
  const m = (text || '').match(/(\d+)\s*ft/i);
  return m ? parseInt(m[1], 10) : null;
}

// ── Parse price from "From $889,000" ─────────────────────────────────────────

function parsePrice(text) {
  const m = (text || '').replace(/,/g, '').match(/\$(\d{5,8})/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Image download ────────────────────────────────────────────────────────────

async function downloadImage(remoteUrl, commSlug, modelSlug) {
  if (!remoteUrl) return null;
  mkdirSync(`${IMAGES_DIR}/${commSlug}`, { recursive: true });
  // Use original (non-resized) image if possible
  const cleanUrl = remoteUrl.replace(/-\d+x\d+(\.\w+)$/, '$1');
  const ext      = (cleanUrl.split('.').pop().split('?')[0] || 'jpg').toLowerCase();
  const safeExt  = ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'jpg';
  const dest     = `${IMAGES_DIR}/${commSlug}/${modelSlug}.${safeExt}`;
  const pub      = `/images/uniform/${commSlug}/${modelSlug}.${safeExt}`;
  if (existsSync(dest)) return pub;
  try {
    const res = await axios.get(cleanUrl, {
      responseType: 'stream', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    await new Promise((resolve, reject) => {
      const w = createWriteStream(dest);
      res.data.pipe(w);
      w.on('finish', resolve);
      w.on('error', reject);
    });
    return pub;
  } catch {
    // Fallback to resized version
    try {
      const res2 = await axios.get(remoteUrl, {
        responseType: 'stream', timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      await new Promise((resolve, reject) => {
        const w = createWriteStream(dest);
        res2.data.pipe(w);
        w.on('finish', resolve);
        w.on('error', reject);
      });
      return pub;
    } catch {
      return remoteUrl;
    }
  }
}

// ── PDF price report ──────────────────────────────────────────────────────────

async function generatePriceReport(browser, communityName, modelsByType, date) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const safeDate = date.replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${slugify(communityName)}-${safeDate}.pdf`;
  const outPath  = `${REPORTS_DIR}/${filename}`;
  const pubPath  = `/data/uniform-price-reports/${filename}`;
  if (existsSync(outPath)) return pubPath;

  // Build sections per type
  const sections = Object.entries(modelsByType).map(([type, models]) => {
    const rows = models.map(m => {
      const statusCls = m.available ? '' : 'sold';
      const imgHtml   = m.localImageUrl
        ? `<img src="${m.localImageUrl}" width="80" height="55" style="object-fit:cover;border-radius:2px">`
        : '';
      return `
        <tr class="${statusCls}">
          <td>${imgHtml}</td>
          <td><strong>${m.name}</strong></td>
          <td>${m.lot ? m.lot + ' ft.' : '—'}</td>
          <td>${m.sqft ? m.sqft.toLocaleString() + ' sq.ft.' : '—'}</td>
          <td>${m.beds ?? '—'} bd / ${m.baths ?? '—'} ba / ${m.garages ?? '—'} gar</td>
          <td>${m.priceFrom ? '$' + m.priceFrom.toLocaleString('en-CA') : (m.available ? '—' : 'Sold Out')}</td>
        </tr>`;
    }).join('');

    // Type priceFrom
    const typePrices = models.filter(m => m.available && m.priceFrom).map(m => m.priceFrom);
    const typeMin    = typePrices.length ? Math.min(...typePrices) : null;

    return `
      <div class="section">
        <div class="section-header">
          <span class="type-label">${type}</span>
          ${typeMin ? `<span class="price-from">From $${typeMin.toLocaleString('en-CA')}</span>` : ''}
        </div>
        <table>
          <thead><tr><th>Image</th><th>Model</th><th>Lot</th><th>Size</th><th>Beds/Baths/Gar</th><th>Price</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; margin: 0; padding: 20px; color: #222; }
  h1   { font-size: 16px; font-weight: 700; margin: 0 0 2px; color: #1a1a1a; letter-spacing: 0.5px; }
  .meta { font-size: 9px; color: #888; margin-bottom: 18px; }
  .section { margin-bottom: 16px; page-break-inside: avoid; }
  .section-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
  .type-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #2c5282; border-bottom: 2px solid #2c5282; padding-bottom: 1px; }
  .price-from { font-size: 10px; color: #555; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #2c5282; color: #fff; padding: 5px 8px; text-align: left; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; }
  td { padding: 5px 8px; border-bottom: 1px solid #e8e8e8; vertical-align: middle; }
  tr:nth-child(even) td { background: #f8f9fc; }
  tr.sold td { color: #bbb; text-decoration: line-through; }
  td:last-child { font-weight: 600; color: #2c5282; }
  tr.sold td:last-child { color: #bbb; }
</style>
</head>
<body>
<h1>Uniform Developments – ${communityName}</h1>
<div class="meta">Price Report · Generated: ${date} · Source: uniformdevelopments.com · Prices do not include HST</div>
${sections}
</body>
</html>`;

  const pg = await browser.newPage();
  await pg.setContent(html, { waitUntil: 'load' });
  await pg.pdf({
    path: outPath, format: 'A4', printBackground: true,
    margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
  });
  await pg.close();
  console.log(`  [uniform] PDF saved: ${filename}`);
  return pubPath;
}

// ── Discover communities ──────────────────────────────────────────────────────

async function discoverCommunities(browser) {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
  await page.goto(`${BASE_URL}/communities/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const communities = await page.evaluate((baseUrl) => {
    const seen = new Set();
    const results = [];
    document.querySelectorAll('a[href*="/community/"]').forEach(a => {
      const href = a.href;
      // Only community root pages (not sub-pages)
      const m = href.match(/\/community\/([a-z0-9-]+)\/?$/);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);

      // Find the nearest heading for the community name
      const container = a.closest('[class*="community"], section, article, div') || a.parentElement;
      const heading = container?.querySelector('h1, h2, h3, h4')?.textContent?.trim()
                   || a.textContent.trim();

      // Check for sold-out badge in container
      const containerText = container?.textContent?.toUpperCase() || '';
      const soldOut  = containerText.includes('SOLD OUT');
      const coming   = containerText.includes('COMING SOON');

      results.push({ slug: m[1], href, name: heading, soldOut, coming });
    });
    return results;
  }, BASE_URL);

  await page.close();
  return communities;
}

// ── Scrape homes page ─────────────────────────────────────────────────────────

async function scrapeHomes(browser, slug) {
  const url = `${BASE_URL}/community/${slug}/homes/`;
  console.log(`  [uniform] Loading: ${url}`);

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Dismiss any fancybox popup
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    document.querySelectorAll('.fancybox-container').forEach(el => el.remove());
    document.body.classList.remove('fancybox-active', 'compensate-for-scrollbar');
    document.body.style.marginRight = '';
  });
  await page.waitForTimeout(300);

  // Click "Load More" until button disappears
  let clicks = 0;
  while (clicks < 50) {
    const btn = await page.$('.homesListing__pagination button');
    if (!btn) break;
    const box = await btn.boundingBox();
    if (!box) break;
    try {
      await btn.click({ force: true });
      await page.waitForTimeout(1200);
      clicks++;
    } catch {
      break;
    }
  }
  if (clicks > 0) console.log(`  [uniform] Clicked "Load More" ${clicks} times`);

  const items = await page.evaluate(() => {
    return [...document.querySelectorAll('.homesListing__item')].map(item => {
      const name   = item.querySelector('.propertyTeaser__title a')?.textContent?.trim() || '';
      const type   = item.querySelector('.propertyTeaser__category')?.textContent?.trim() || '';
      const lot    = item.querySelector('.propertyTeaser__lot')?.textContent?.trim() || '';
      const meta   = [...item.querySelectorAll('.propertyTeaser__metaItem')]
                       .map(m => m.textContent.replace(/\s+/g, ' ').trim());
      const price  = item.querySelector('.propertyTeaser__price')?.textContent?.trim() || '';
      const label  = item.querySelector('.propertyTeaser__label')?.textContent?.trim() || '';
      const img    = item.querySelector('img.propertyTeaser__image')?.src || '';
      const url    = item.querySelector('.propertyTeaser__title a')?.href || '';
      return { name, type, lot, meta, price, label, img, url };
    }).filter(i => i.name);
  });

  await page.close();
  return items;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function scrape() {
  console.log('[uniform] Starting Uniform Developments scrape...');
  const browser = await chromium.launch({ headless: true });
  const builds  = [];
  const date    = new Date().toISOString();

  try {
    // Discover communities
    const communities = await discoverCommunities(browser);
    console.log(`[uniform] Found ${communities.length} communities`);
    await sleep(500);

    for (const comm of communities) {
      // Skip per user instructions
      if (SKIP_SLUGS.has(comm.slug)) {
        console.log(`[uniform] Skipping: ${comm.slug}`);
        continue;
      }

      console.log(`\n[uniform] ${comm.name || comm.slug} (${comm.slug})`);
      const meta      = COMMUNITY_META[comm.slug] || {};
      const commSlug  = comm.slug;

      // Scrape homes
      let rawItems = [];
      try {
        rawItems = await scrapeHomes(browser, commSlug);
        console.log(`  → ${rawItems.length} homes found`);
      } catch (err) {
        console.warn(`  [uniform] Failed to scrape homes: ${err.message}`);
        await sleep(500);
        continue;
      }

      if (!rawItems.length) {
        console.warn(`  [uniform] No homes found for ${commSlug}`);
        continue;
      }

      // Parse and normalize models
      const models = [];
      for (const item of rawItems) {
        const type     = normalizeType(item.type);
        const lotWidth = parseLotWidth(item.lot);
        const sqft     = item.meta[0] ? parseInt(item.meta[0].replace(/[^\d]/g, ''), 10) || null : null;
        const beds     = item.meta[1] ? parseFloat(item.meta[1]) || null : null;
        const baths    = item.meta[2] ? parseFloat(item.meta[2]) || null : null;
        const garages  = item.meta[3] ? parseFloat(item.meta[3]) || null : null;
        const price    = parsePrice(item.price);
        const available = !item.label || !/sold.?out/i.test(item.label);
        const modelSlug = slugify(item.name);

        let localImageUrl = null;
        if (item.img) {
          localImageUrl = await downloadImage(item.img, commSlug, modelSlug);
          await sleep(60);
        }

        models.push({
          name:          item.name,
          type,
          sqft,
          beds,
          baths,
          garages,
          lotWidth,
          priceFrom:     price,
          available,
          localImageUrl,
          modelUrl:      item.url,
        });
      }

      // Group by type for PDF + typePrices
      const modelsByType = {};
      for (const m of models) {
        if (!modelsByType[m.type]) modelsByType[m.type] = [];
        modelsByType[m.type].push(m);
      }

      // typePrices: min available price per type
      const typePrices = Object.entries(modelsByType)
        .map(([type, ms]) => {
          const prices = ms.filter(m => m.available && m.priceFrom).map(m => m.priceFrom);
          const p = prices.length ? Math.min(...prices) : null;
          return p ? { type, priceFrom: p, priceFromFormatted: formatPrice(p) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.priceFrom - b.priceFrom);

      const allPrices  = typePrices.map(t => t.priceFrom).filter(Boolean);
      const priceFrom  = allPrices.length ? Math.min(...allPrices) : null;

      const homeTypes = [...new Set(models.map(m => typeToHomeType(m.type)))];
      const mapType   = typeToMapType(models.map(m => m.type));

      // Generate PDF
      let priceReportUrl = null;
      try {
        priceReportUrl = await generatePriceReport(browser, comm.name || comm.slug, modelsByType, date);
      } catch (err) {
        console.warn(`  [uniform] PDF failed: ${err.message}`);
      }

      const displayName = comm.name || comm.slug;

      builds.push({
        id:                  `uniform-${commSlug}`,
        name:                displayName,
        builder:             'Uniform Developments',
        community:           meta.neighbourhood || 'Ottawa',
        address:             meta.address || `${displayName}, Ottawa, ON`,
        lat:                 meta.lat || null,
        lng:                 meta.lng || null,
        homeTypes,
        type:                mapType,
        models,
        typePrices,
        priceFrom,
        priceFromFormatted:  formatPrice(priceFrom),
        taxIncluded:         false,
        featureSheets:       [],
        includedFeatures:    [],
        priceReportUrl,
        status:              'selling',
        completionYear:      null,
        description:         `A Uniform Developments community in ${meta.neighbourhood || 'Ottawa'}.`,
        sourceUrl:           `${BASE_URL}/community/${commSlug}/`,
        sourceName:          'uniformdevelopments.com',
        imageUrl:            '',
        scrapedAt:           date,
      });

      console.log(`  ✓ ${models.length} models | typePrices: ${typePrices.map(t => `${t.type} ${t.priceFromFormatted}`).join(', ')}`);
      await sleep(800);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n[uniform] Done — ${builds.length} communities`);
  return builds;
}
