/**
 * Scraper for Claridge Homes — claridgehomes.com
 *
 * Discovers all communities from /our-communities/.
 * For each active community scrapes the community page for model cards:
 *   - Each .filterable-home has data-model (type), data-sqft, data-bedrooms, data-bathrooms
 *   - Model image extracted from background-image CSS on .listing-home-image
 *   - Model detail page fetched for lot width (h6.accent-gold: "37′ Lot")
 *
 * Alta Vista Quarters → coming-soon stub (Townhomes + 3-Storey Townhomes)
 *
 * Price: Not available — Claridge does not publish prices on their website.
 * Garage count: Not published — omitted (null).
 * taxIncluded: false (no prices)
 *
 * Type mapping from data-model attribute:
 *   "single-family"       → Single Family
 *   "bungalows"           → Bungalows
 *   "townhomes"           → Townhomes
 *   "rear-lane-townhomes" → Rear-Lane Townhomes
 *   "back2back-townhomes" → Back2Back Townhomes
 *   "3-storey-townhomes"  → 3-Storey Townhomes
 *   "semi-detached"       → Semi-Detached
 *   "move-in-ready"       → skipped
 */
import { chromium } from 'playwright-core';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import axios from 'axios';
import { formatPrice, slugify, sleep } from '../utils.js';

const BASE_URL    = 'https://www.claridgehomes.com';
const REPORTS_DIR = new URL('../../public/data/claridge-price-reports', import.meta.url).pathname;
const IMAGES_DIR  = new URL('../../public/images/claridge', import.meta.url).pathname;

// ── Skip / coming-soon slugs ──────────────────────────────────────────────────
const COMING_SOON_SLUGS = new Set(['alta-vista-quarters']);

// ── Hardcoded community metadata ──────────────────────────────────────────────
const COMMUNITY_META = {
  'copperwood-estate':   { neighbourhood: 'Kanata North',   address: '2008 Bosch Place, Kanata, ON K2W 1A1',            lat: 45.3450, lng: -75.9120 },
  'westwood':            { neighbourhood: 'Stittsville',    address: '571 Bobolink Ridge, Stittsville, ON K2S 1S3',     lat: 45.2540, lng: -75.9350 },
  'iron-valley':         { neighbourhood: 'Kanata South',   address: '2010 Allegrini Terrace, Kanata, ON K2S 2S7',      lat: 45.2930, lng: -75.9230 },
  'bridlewood-trails':   { neighbourhood: 'Kanata South',   address: '2010 Allegrini Terrace, Kanata, ON K2S 2S7',      lat: 45.2850, lng: -75.9180 },
  'watters-pointe':      { neighbourhood: 'Barrhaven',      address: '706 Hosta Drive, Riverside South, ON K4M 0N7',    lat: 45.2720, lng: -75.6870 },
  'rivers-edge':         { neighbourhood: 'Riverside South',address: '706 Hosta Drive, Riverside South, ON K4M 0N7',    lat: 45.2700, lng: -75.6840 },
  'lilythorne':          { neighbourhood: 'Findlay Creek',  address: '3275 Findlay Creek Drive, Ottawa, ON K1T 0A9',    lat: 45.3290, lng: -75.5990 },
  'alta-vista-quarters': { neighbourhood: 'Alta Vista',     address: '505 Preston St, Ottawa, ON K1S 4N7',              lat: 45.4108, lng: -75.7094 },
};

// ── Type normalization ────────────────────────────────────────────────────────

const TYPE_MAP = {
  'single-family':          'Single Family',
  'bungalows':              'Bungalows',
  'townhomes':              'Townhomes',
  'rear-lane-townhomes':    'Rear-Lane Townhomes',
  'back2back-townhomes':    'Back2Back Townhomes',
  '3-storey-townhomes':     '3-Storey Townhomes',
  'semi-detached':          'Semi-Detached',
  'move-in-ready':          null,   // skip
  'move-in-ready-homes':    null,   // skip
  'zen-urban-flats':        null,   // skip (condo product)
};

function normalizeType(raw) {
  const key = (raw || '').toLowerCase().replace(/\s+/g, '-');
  return TYPE_MAP.hasOwnProperty(key) ? TYPE_MAP[key] : (raw?.trim() || 'Unknown');
}

function isTownType(type) {
  return /town|semi|back2back|rear/i.test(type);
}

function typesToMapType(types) {
  const hasSF   = types.some(t => /single|bungalow/i.test(t));
  const hasTown = types.some(t => isTownType(t));
  if (hasSF && hasTown) return 'mixed';
  if (hasTown)          return 'townhouse';
  return 'single-family';
}

function homeTypeGroup(type) {
  if (isTownType(type) || type === '3-Storey Townhomes') return 'Townhomes';
  if (type === 'Semi-Detached') return 'Semi-Detached';
  if (type === 'Bungalows')     return 'Bungalows';
  return 'Single Family';
}

// ── Image download ────────────────────────────────────────────────────────────

async function downloadImage(remoteUrl, commSlug, modelSlug) {
  if (!remoteUrl) return null;
  mkdirSync(`${IMAGES_DIR}/${commSlug}`, { recursive: true });
  const rawExt = (remoteUrl.split('.').pop().split('?')[0] || 'jpg').toLowerCase();
  const ext    = ['jpg', 'jpeg', 'png', 'webp'].includes(rawExt) ? rawExt : 'jpg';
  const dest   = `${IMAGES_DIR}/${commSlug}/${modelSlug}.${ext}`;
  const pub    = `/images/claridge/${commSlug}/${modelSlug}.${ext}`;
  if (existsSync(dest)) return pub;
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
    return pub;
  } catch {
    return remoteUrl;
  }
}

// ── PDF model reference sheet ─────────────────────────────────────────────────

async function generatePriceReport(browser, communityName, modelsByType, date) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const safeDate = date.slice(0, 10); // date only — one PDF per community per day
  const filename = `${slugify(communityName)}-${safeDate}.pdf`;
  const outPath  = `${REPORTS_DIR}/${filename}`;
  const pubPath  = `/data/claridge-price-reports/${filename}`;
  if (existsSync(outPath)) return pubPath;

  const sectionsHtml = Object.entries(modelsByType).map(([type, models]) => {
    const rows = models.map(m => {
      const imgHtml = m.localImageUrl
        ? `<img src="${m.localImageUrl}" width="80" height="55" style="object-fit:cover;border-radius:3px">`
        : '<span style="color:#ccc;font-size:9px">–</span>';
      return `
        <tr>
          <td>${imgHtml}</td>
          <td><strong>${m.name}</strong></td>
          <td>${m.sqft ? m.sqft.toLocaleString() + ' sq.ft.' : '—'}</td>
          <td>${m.beds ?? '—'} bd / ${m.baths ?? '—'} ba</td>
          <td>${m.lotWidth ? m.lotWidth + '′' : '—'}</td>
          <td style="color:#999;font-style:italic">Not available</td>
        </tr>`;
    }).join('');
    return `
      <div class="section">
        <div class="section-header">
          <span class="type-label">${type}</span>
          <span class="na-note">Pricing not published by builder</span>
        </div>
        <table>
          <thead><tr><th>Image</th><th>Model</th><th>Size</th><th>Beds/Baths</th><th>Lot</th><th>Price</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; margin: 0; padding: 20px; color: #1a1a1a; }
  h1   { font-size: 15px; font-weight: 700; margin: 0 0 2px; }
  .meta { font-size: 9px; color: #888; margin-bottom: 18px; }
  .section { margin-bottom: 16px; page-break-inside: avoid; }
  .section-header { display: flex; align-items: baseline; gap: 12px; border-bottom: 2px solid #c8a96e; padding-bottom: 3px; margin-bottom: 5px; }
  .type-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; }
  .na-note { font-size: 9px; color: #aaa; font-style: italic; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #1a1a1a; color: #fff; padding: 5px 8px; text-align: left; font-size: 9px; font-weight: 600; text-transform: uppercase; }
  td { padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: middle; }
  tr:nth-child(even) td { background: #fafafa; }
</style></head><body>
<h1>Claridge Homes – ${communityName} | Model Reference Sheet</h1>
<div class="meta">Generated: ${date} &nbsp;·&nbsp; Source: claridgehomes.com &nbsp;·&nbsp; Prices not published by builder</div>
${sectionsHtml}
</body></html>`;

  const pg = await browser.newPage();
  await pg.setContent(html, { waitUntil: 'load' });
  await pg.pdf({ path: outPath, format: 'A4', printBackground: true,
    margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  await pg.close();
  console.log(`  [claridge] PDF saved: ${filename}`);
  return pubPath;
}

// ── Page loader ───────────────────────────────────────────────────────────────

async function loadPage(browser, url) {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2000);
    return page;
  } catch (err) {
    await page.close();
    throw err;
  }
}

// ── Discover communities ──────────────────────────────────────────────────────

async function discoverCommunities(browser) {
  const page = await loadPage(browser, `${BASE_URL}/our-communities/`);
  const communities = await page.evaluate(() => {
    const seen = new Set();
    const results = [];
    document.querySelectorAll('a[href*="/community/"]').forEach(a => {
      const href = a.href;
      const m = href.match(/\/community\/([a-z0-9-]+)\/?$/);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      // Find name from surrounding card
      const container = a.closest('div, li, article') || a.parentElement;
      const name = container?.querySelector('h2,h3,h4')?.textContent?.trim() || a.textContent.trim();
      results.push({ slug: m[1], href, rawName: name });
    });
    return results;
  });
  await page.close();
  return communities;
}

// ── Scrape community page ─────────────────────────────────────────────────────

async function scrapeCommunity(browser, slug, url) {
  const page = await loadPage(browser, url);

  const result = await page.evaluate(() => {
    // Display name from H2 community heading
    const h2s = [...document.querySelectorAll('h2')];
    const commH2 = h2s.find(h => !h.textContent.includes('Model Types') && !h.textContent.includes('Sales Centre') && !h.textContent.includes('Talk to'));
    const displayName = (commH2?.textContent || '')
      .replace(/\s*[–—-]\s*(new homes|homes)\s+in.*/i, '')
      .trim();

    // All filterable model cards
    const cards = [...document.querySelectorAll('.filterable-home')].map(cell => {
      const type = cell.getAttribute('data-model') || '';
      if (type === 'move-in-ready') return null;

      const link = cell.querySelector('a.listing-home');
      const name = link?.querySelector('h4')?.textContent?.trim() || '';
      if (!name) return null;

      const href      = link?.href || '';
      const modelSlug = href.split('/home/')[1]?.replace(/\/$/, '') || '';

      // Elevation image from background-image style
      const imgEl    = link?.querySelector('.listing-home-image');
      const bgStyle  = imgEl?.getAttribute('style') || '';
      const imgMatch = bgStyle.match(/url\(["']?([^"')]+)["']?\)/);
      const img      = imgMatch ? imgMatch[1] : '';

      const sqft     = cell.getAttribute('data-sqft')      ? parseInt(cell.getAttribute('data-sqft'), 10)     : null;
      const beds     = cell.getAttribute('data-bedrooms')   ? parseInt(cell.getAttribute('data-bedrooms'), 10) : null;
      const bathsRaw = cell.getAttribute('data-bathrooms') || '';
      // "2-5" → 2.5, "2" → 2
      const baths    = bathsRaw.includes('-') ? parseFloat(bathsRaw.replace('-', '.')) : (parseFloat(bathsRaw) || null);

      return { name, type, sqft, beds, baths, img, href, modelSlug };
    }).filter(Boolean);

    return { displayName, cards };
  });

  await page.close();
  return result;
}

// ── Fetch lot width from model detail page ────────────────────────────────────

async function fetchLotWidth(browser, modelUrl) {
  if (!modelUrl) return null;
  let page;
  try {
    page = await loadPage(browser, modelUrl);
    const lotWidth = await page.evaluate(() => {
      const h6 = [...document.querySelectorAll('h6')].find(h => /LOT/i.test(h.textContent));
      if (!h6) return null;
      const m = h6.textContent.match(/(\d+)[′']/);
      return m ? parseInt(m[1], 10) : null;
    });
    await page.close();
    return lotWidth;
  } catch {
    if (page) await page.close().catch(() => {});
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function scrape() {
  console.log('[claridge] Starting Claridge Homes scrape...');
  const browser = await chromium.launch({ headless: true });
  const builds  = [];
  const date    = new Date().toISOString();

  try {
    const communities = await discoverCommunities(browser);
    console.log(`[claridge] Found ${communities.length} communities`);
    await sleep(400);

    for (const comm of communities) {
      const meta = COMMUNITY_META[comm.slug] || {};

      // ── Coming Soon stub ──────────────────────────────────────────────────
      if (COMING_SOON_SLUGS.has(comm.slug)) {
        console.log(`[claridge] Coming soon stub: ${comm.slug}`);
        builds.push({
          id:                  `claridge-${comm.slug}`,
          name:                'Alta Vista Quarters',
          builder:             'Claridge Homes',
          community:           meta.neighbourhood || 'Ottawa',
          address:             meta.address || 'Ottawa, ON',
          lat:                 meta.lat || null,
          lng:                 meta.lng || null,
          homeTypes:           ['Townhomes', '3-Storey Townhomes'],
          type:                'townhouse',
          models:              [],
          typePrices:          [],
          priceFrom:           null,
          priceFromFormatted:  null,
          taxIncluded:         false,
          featureSheets:       [],
          includedFeatures:    [],
          priceReportUrl:      null,
          status:              'upcoming',
          completionYear:      null,
          description:         'Coming soon Claridge community in Alta Vista, Ottawa. Opening May 2026.',
          sourceUrl:           comm.href,
          sourceName:          'claridgehomes.com',
          imageUrl:            '',
          scrapedAt:           date,
        });
        continue;
      }

      // ── Active community ──────────────────────────────────────────────────
      console.log(`\n[claridge] ${comm.slug}`);

      let commData;
      try {
        commData = await scrapeCommunity(browser, comm.slug, comm.href);
        await sleep(400);
      } catch (err) {
        console.warn(`  [claridge] Failed: ${err.message}`);
        continue;
      }

      const { displayName, cards } = commData;
      if (!cards.length) {
        console.warn(`  [claridge] No models found`);
        continue;
      }

      console.log(`  → ${cards.length} models found`);

      // Lot width cache (by model slug — same model can appear in multiple communities)
      const lotWidthCache = {};
      const models = [];

      for (const card of cards) {
        const type = normalizeType(card.type);
        if (type === null) continue;

        const modelSlug = slugify(card.name);

        // Lot width via model detail page
        let lotWidth = null;
        if (card.modelSlug) {
          if (!(card.modelSlug in lotWidthCache)) {
            lotWidthCache[card.modelSlug] = await fetchLotWidth(browser, card.href);
            await sleep(250);
          }
          lotWidth = lotWidthCache[card.modelSlug];
        }

        // Download elevation image
        let localImageUrl = null;
        if (card.img) {
          localImageUrl = await downloadImage(card.img, comm.slug, modelSlug);
          await sleep(50);
        }

        models.push({
          name:          card.name,
          type,
          sqft:          card.sqft,
          beds:          card.beds,
          baths:         card.baths,
          garages:       null,
          lotWidth,
          priceFrom:     null,
          available:     true,
          localImageUrl,
          modelUrl:      card.href,
        });
      }

      // Group by type for PDF
      const modelsByType = {};
      for (const m of models) {
        if (!modelsByType[m.type]) modelsByType[m.type] = [];
        modelsByType[m.type].push(m);
      }

      const homeTypes = [...new Set(models.map(m => homeTypeGroup(m.type)))];
      const mapType   = typesToMapType(models.map(m => m.type));

      // PDF
      let priceReportUrl = null;
      // Strip taglines: "Iron Valley – Modern Homes in Kanata South" → "Iron Valley"
      //                  "Discover Lilythorne" → "Lilythorne"
      const commName = displayName
        ? displayName
            .replace(/\s*[–—]\s*.+$/i, '')       // strip everything after em/en-dash
            .replace(/^discover\s+/i, '')          // strip leading "Discover"
            .trim()
        : comm.slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      try {
        priceReportUrl = await generatePriceReport(browser, commName, modelsByType, date);
      } catch (err) {
        console.warn(`  [claridge] PDF failed: ${err.message}`);
      }

      builds.push({
        id:                  `claridge-${comm.slug}`,
        name:                commName,
        builder:             'Claridge Homes',
        community:           meta.neighbourhood || 'Ottawa',
        address:             meta.address || `${commName}, Ottawa, ON`,
        lat:                 meta.lat || null,
        lng:                 meta.lng || null,
        homeTypes,
        type:                mapType,
        models,
        typePrices:          [],
        priceFrom:           null,
        priceFromFormatted:  null,
        taxIncluded:         false,
        featureSheets:       [],
        includedFeatures:    [],
        priceReportUrl,
        status:              'selling',
        completionYear:      null,
        description:         `A Claridge Homes community in ${meta.neighbourhood || 'Ottawa'}.`,
        sourceUrl:           comm.href,
        sourceName:          'claridgehomes.com',
        imageUrl:            '',
        scrapedAt:           date,
      });

      console.log(`  ✓ ${commName}: ${models.length} models (${[...new Set(models.map(m => m.type))].join(', ')})`);
      await sleep(700);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n[claridge] Done — ${builds.length} communities`);
  return builds;
}
