/**
 * Scraper for Minto Communities — minto.com/ottawa
 *
 * Discovers all Ottawa communities from the projects page, then for each:
 *   - Scrapes all collection pages (Single Family, Townhomes, Bungalows, etc.)
 *   - Extracts models: name, sqft, beds, baths, garages, price, image, availability
 *   - Extracts incentive text per section (used as feature sheet)
 *   - Generates a price PDF report per community
 *
 * Key details:
 *   - Collection pages require Referer: <community>/main.html to avoid 403
 *   - Model data is pipe-delimited in text: |avail| |type| |beds| price sqft |baths| |garages|
 *   - Lot width parsed from section heading: "36' Single Family Homes" → 36
 *   - "Leaside | Lower Interior" → "Lower Leaside" (pipe-name normalization)
 *   - taxIncluded = true (prices include HST)
 */
import { chromium } from 'playwright-core';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import axios from 'axios';
import { formatPrice, slugify, sleep } from '../utils.js';

const BASE_URL = 'https://www.minto.com';
const PROJECTS_URL = `${BASE_URL}/ottawa/new-homes-condos/projects.html`;
const REPORTS_DIR = new URL('../../public/data/minto-price-reports', import.meta.url).pathname;
const IMAGES_DIR  = new URL('../../public/images/minto', import.meta.url).pathname;

// ── Known communities ─────────────────────────────────────────────────────────
// Static coords (Nominatim 403s) — based on sales centre or community location
const KNOWN_COMMUNITIES = [
  {
    slug: 'Harmony',      displayName: 'Riversbend at Harmony',
    area: 'new-homes',    neighbourhood: 'Barrhaven',
    lat: 45.2636,         lng: -75.7582,   // 4005 Strandherd Dr
  },
  {
    slug: 'Abbotts-Run',  displayName: "Abbott's Run",
    area: 'new-homes',    neighbourhood: 'Stittsville',
    lat: 45.2803,         lng: -75.9009,   // 5618 Hazeldean Rd
  },
  {
    slug: 'Arcadia',      displayName: 'Arcadia',
    area: 'Kanata-new-homes', neighbourhood: 'Kanata',
    lat: 45.3015,         lng: -75.9358,   // 380 Huntmar Dr
  },
  {
    slug: 'Mahogany',     displayName: 'Mahogany',
    area: 'Manotick-new-homes', neighbourhood: 'Manotick',
    lat: 45.2183,         lng: -75.6741,   // 108 Moretto Ct
  },
  {
    slug: 'Brookline',    displayName: 'Brookline',
    area: 'Kanata-new-homes', neighbourhood: 'Kanata',
    lat: 45.2956,         lng: -75.9180,   // Kanata West (near Brookline community)
  },
  {
    slug: 'Anthem',       displayName: 'Anthem',
    area: 'new-homes',    neighbourhood: 'Barrhaven',
    lat: 45.2585,         lng: -75.7592,   // Barrhaven South
    // Main page has no collections-tag links — provide directly
    collectionLinks: [
      { text: 'Metro Townhomes', href: 'https://www.minto.com/ottawa/new-homes/Anthem/collections-tag/Metro-Townhomes.html' },
    ],
  },
  {
    slug: "Quinn-s-Pointe", displayName: "Quinn's Pointe",
    area: 'new-homes',    neighbourhood: 'Barrhaven',
    lat: 45.2635,         lng: -75.7697,   // Barrhaven
    soldOut: true,
  },
  {
    slug: 'Avalon',       displayName: 'Avalon Vista',
    area: 'Orleans-new-homes', neighbourhood: 'Orléans',
    lat: 45.4494,         lng: -75.4818,   // 2370 Tenth Line Rd
  },
];

// ── Name normalization ────────────────────────────────────────────────────────

/**
 * Normalize Minto pipe-names: "Leaside | Lower Interior" → "Lower Leaside"
 *                              "Leaside | Lower End"      → "Lower End Leaside"
 */
function normalizeModelName(raw) {
  const m = raw.match(/^(.+?)\s*\|\s*(.+)$/);
  if (!m) return raw.trim();
  const base      = m[1].trim();
  const qualifier = m[2].trim().replace(/\s*Interior\s*$/i, '').trim();
  return `${qualifier} ${base}`.trim();
}

// ── Type mapping ──────────────────────────────────────────────────────────────

function pipeTypeToHomeType(pipeType) {
  const t = (pipeType || '').toLowerCase();
  if (t.includes('town'))    return 'Townhomes';
  if (t.includes('bungalow') || t.includes('dual_key')) return 'Single Family';
  return 'Single Family';
}

function sectionToHomeType(section) {
  const s = (section || '').toLowerCase();
  if (s.includes('town'))    return 'Townhomes';
  if (s.includes('bungalow') || s.includes('dual key')) return 'Single Family';
  return 'Single Family';
}

function sectionToMapType(homeTypes) {
  const hasSF   = homeTypes.includes('Single Family');
  const hasTown = homeTypes.includes('Townhomes');
  if (hasSF && hasTown) return 'mixed';
  if (hasTown) return 'townhouse';
  return 'single-family';
}

/** Extract lot width from section heading like "36' Single Family Homes" */
function parseLotWidth(section) {
  const m = (section || '').match(/(\d+)[\'′]/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Image download ────────────────────────────────────────────────────────────

async function downloadImage(remoteUrl, slug, modelName) {
  mkdirSync(`${IMAGES_DIR}/${slug}`, { recursive: true });
  const ext      = remoteUrl.split('.').pop().split('?')[0] || 'jpg';
  const filename = `${slugify(modelName)}.${ext}`;
  const dest     = `${IMAGES_DIR}/${slug}/${filename}`;
  const pubPath  = `/images/minto/${slug}/${filename}`;
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
    return remoteUrl;
  }
}

// ── PDF price report ──────────────────────────────────────────────────────────

async function generatePriceReport(browser, communityName, blocks, date) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const safeDate = date.slice(0, 10); // date only — one PDF per community per day
  const filename = `${slugify(communityName)}-${safeDate}.pdf`;
  const outPath  = `${REPORTS_DIR}/${filename}`;
  if (existsSync(outPath)) return `/data/minto-price-reports/${filename}`;

  const rows = blocks.flatMap(b =>
    b.models.map(m => `
      <tr class="${m.available ? '' : 'sold'}">
        <td>${b.section}</td>
        <td><img src="${m.remoteImageUrl}" onerror="this.style.display='none'" width="80" height="60" style="object-fit:cover"></td>
        <td>${m.name}</td>
        <td>${m.sqft ? m.sqft.toLocaleString() + ' sqft' : '—'}</td>
        <td>${m.beds ?? '—'} bd / ${m.baths ?? '—'} ba</td>
        <td>${m.price ? '$' + m.price.toLocaleString('en-CA') : '—'}</td>
        <td>${m.available ? 'Available' : 'Sold Out'}</td>
      </tr>`)
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
  th { background: #003057; color: #fff; padding: 6px 8px; text-align: left; font-size: 10px; }
  td { padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: middle; }
  tr.sold td { color: #aaa; text-decoration: line-through; }
  tr:hover td { background: #f9f9f9; }
</style>
</head>
<body>
<h1>Minto – ${communityName} | Price Report</h1>
<div class="meta">Generated: ${date} | Data from minto.com</div>
<table>
  <thead><tr><th>Collection</th><th>Image</th><th>Model</th><th>Size</th><th>Beds/Baths</th><th>Price</th><th>Status</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body>
</html>`;

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' } });
  await page.close();
  console.log(`  [minto] PDF saved: ${filename}`);
  return `/data/minto-price-reports/${filename}`;
}

// ── Load a page with Referer (required to avoid 403) ─────────────────────────

async function loadPage(browser, url, referer) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.5', 'Referer': referer },
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(3500);
  return { page, context };
}

// ── Scrape a single collection page ──────────────────────────────────────────

async function scrapeCollectionPage(browser, url, referer) {
  const { page, context } = await loadPage(browser, url, referer);
  const blocks = await page.evaluate(() => {
    return [...document.querySelectorAll('.collection-block')].map(block => {
      const section = block.querySelector('h2')?.textContent?.trim() || '';

      // Incentive text
      const incentiveP = [...block.querySelectorAll('p')].find(p => /incentive/i.test(p.textContent));
      const incentive  = incentiveP?.nextElementSibling?.textContent?.trim() || '';

      // Main model cards (.serie-72 class, not elevation sub-cards)
      const models = [...block.querySelectorAll('[class*="serie-72"]')].map(card => {
        const name = card.querySelector('h3, h4, .regional-h-h4-dark')?.textContent?.trim() || '';
        if (!name) return null;
        const img = card.querySelector('img')?.src || '';
        const raw = card.textContent.replace(/\s+/g, ' ').trim();
        // Pipe format: |avail| |type| |beds| price sqft |baths| |garages|
        const m = raw.match(/\|(\d)\|\s*\|(\w+)\|\s*\|(\d+)\|\s*(\d+)\s*(\d+)\s*\|(\d+\.?\d*)\|\s*\|(\d+)\|/);
        return {
          name,
          remoteImageUrl: img,
          available: m ? m[1] === '1' : true,
          pipeType:  m ? m[2] : '',
          beds:      m ? parseInt(m[3]) : null,
          price:     m ? parseInt(m[4]) : null,
          sqft:      m ? parseInt(m[5]) : null,
          baths:     m ? parseFloat(m[6]) : null,
          garages:   m ? parseInt(m[7]) : null,
        };
      }).filter(c => c && c.name);

      const availPrices = models.filter(c => c.available && c.price > 0).map(c => c.price);
      const anyPrices   = models.filter(c => c.price > 0).map(c => c.price);
      const priceFrom   = availPrices.length ? Math.min(...availPrices)
                        : anyPrices.length   ? Math.min(...anyPrices)
                        : null;

      return { section, incentive, priceFrom, models };
    });
  });

  await context.close();
  return blocks;
}

// ── Discover collection links from a community main page ──────────────────────

async function fetchCollectionLinks(browser, mainUrl) {
  const { page, context } = await loadPage(browser, mainUrl, PROJECTS_URL);
  const links = await page.evaluate(() => {
    return [...document.querySelectorAll('a[href*="collections-tag"]')]
      .map(a => ({ text: a.textContent.trim(), href: a.href }))
      .filter(a => a.text && !/(sign.?up|register)/i.test(a.text));
  });
  // Deduplicate by href
  const seen = new Set();
  const unique = links.filter(l => { if (seen.has(l.href)) return false; seen.add(l.href); return true; });
  await context.close();
  return unique;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function scrape() {
  console.log('[minto] Starting Ottawa scrape...');
  const browser = await chromium.launch({ headless: true });
  const builds   = [];
  const date     = new Date().toISOString();

  try {
    for (const comm of KNOWN_COMMUNITIES) {
      const mainUrl = `${BASE_URL}/ottawa/${comm.area}/${comm.slug}/main.html`;
      const id      = `minto-${slugify(comm.slug)}`;
      console.log(`\n[minto] ${comm.displayName} (${comm.neighbourhood})`);

      // Quinn's Pointe — sold out stub
      if (comm.soldOut) {
        builds.push({
          id, name: comm.displayName, builder: 'Minto Communities',
          community: comm.neighbourhood,
          address: `${comm.displayName}, ${comm.neighbourhood}, Ottawa, ON`,
          lat: comm.lat, lng: comm.lng,
          homeTypes: [], type: 'unknown', models: [],
          typePrices: [], priceFrom: null, priceFromFormatted: null,
          taxIncluded: true,
          featureSheets: [], includedFeatures: [],
          status: 'sold-out', completionYear: null,
          description: `${comm.displayName} is currently sold out.`,
          sourceUrl: mainUrl, sourceName: 'minto.com',
          imageUrl: '', scrapedAt: date,
        });
        console.log(`  → Sold out — skipped scraping`);
        continue;
      }

      // Get collection links — use hard-coded if provided, else discover from main page
      let collectionLinks = comm.collectionLinks || [];
      if (!collectionLinks.length) {
        try {
          collectionLinks = await fetchCollectionLinks(browser, mainUrl);
        } catch (err) {
          console.warn(`  [minto] Failed to fetch main page: ${err.message}`);
          continue;
        }
        await sleep(500);
      }

      console.log(`  Collections: ${collectionLinks.map(l => l.text).join(', ')}`);
      if (!collectionLinks.length) {
        console.warn(`  [minto] No collection links found for ${comm.displayName}`);
        continue;
      }

      // Scrape each collection page
      const allBlocks      = [];
      const allIncluded    = [];
      const typeFeatureMap = {}; // section → incentive text

      for (const link of collectionLinks) {
        try {
          console.log(`  → Scraping: ${link.text}`);
          const blocks = await scrapeCollectionPage(browser, link.href, mainUrl);
          for (const block of blocks) {
            if (block.models.length) allBlocks.push(block);
            if (block.incentive && !typeFeatureMap[block.section]) {
              typeFeatureMap[block.section] = block.incentive;
              allIncluded.push(block.incentive);
            }
          }
          await sleep(600);
        } catch (err) {
          console.warn(`    Failed: ${err.message}`);
        }
      }

      // Merge blocks that appear on multiple collection pages — deduplicate by model name
      const merged   = [];
      const seenMdls = new Set();
      for (const block of allBlocks) {
        const models = block.models.filter(m => {
          const key = `${block.section}::${m.name}`;
          if (seenMdls.has(key)) return false;
          seenMdls.add(key);
          return true;
        });
        if (models.length) merged.push({ ...block, models });
      }

      // Download images + normalize names
      for (const block of merged) {
        const lotWidth = parseLotWidth(block.section);
        for (const m of block.models) {
          m.name     = normalizeModelName(m.name);
          m.lotWidth = lotWidth;
          m.type     = pipeTypeToHomeType(m.pipeType) === 'Townhomes' ? 'Townhomes' : 'Single Family';
          if (m.remoteImageUrl) {
            m.localImageUrl = await downloadImage(m.remoteImageUrl, comm.slug.toLowerCase(), m.name);
            await sleep(80);
          }
          delete m.pipeType;
          delete m.remoteImageUrl;
        }
      }

      // Build typePrices
      const typePrices = merged
        .filter(b => b.priceFrom)
        .map(b => ({ type: b.section, priceFrom: b.priceFrom, priceFromFormatted: formatPrice(b.priceFrom) }));

      const allPrices   = typePrices.map(t => t.priceFrom).filter(Boolean);
      const priceFrom   = allPrices.length ? Math.min(...allPrices) : null;

      // homeTypes
      const homeTypes   = [...new Set(merged.flatMap(b => b.models.map(m => m.type)))];

      // Feature sheets (incentive text per section)
      const featureSheets = Object.entries(typeFeatureMap).map(([section, text]) => ({
        name:     `Minto - ${comm.displayName} - ${section} - feature sheet`,
        text,
        localUrl: null,
      }));

      // All models flat
      const allModels = merged.flatMap(b => b.models.map(m => ({
        ...m,
        modelUrl:  `${BASE_URL}/ottawa/${comm.area}/${comm.slug}/collections-tag/${b.section.replace(/\s+/g, '-')}.html`,
        priceFrom: m.price,
      })));

      // Generate price PDF
      let priceReportUrl = null;
      try {
        priceReportUrl = await generatePriceReport(browser, comm.displayName, merged, date);
      } catch (err) {
        console.warn(`  [minto] PDF generation failed: ${err.message}`);
      }

      builds.push({
        id, name: comm.displayName, builder: 'Minto Communities',
        community: comm.neighbourhood,
        address: `${comm.displayName}, ${comm.neighbourhood}, Ottawa, ON`,
        lat: comm.lat, lng: comm.lng,
        homeTypes,
        type: sectionToMapType(homeTypes),
        models: allModels,
        typePrices,
        priceFrom,
        priceFromFormatted: formatPrice(priceFrom),
        taxIncluded: true,
        featureSheets,
        includedFeatures: [...new Set(allIncluded)],
        priceReportUrl,
        status: 'selling',
        completionYear: null,
        description: `A Minto Communities development in ${comm.neighbourhood}, Ottawa.`,
        sourceUrl: mainUrl, sourceName: 'minto.com',
        imageUrl: '', scrapedAt: date,
      });

      console.log(`  ✓ ${allModels.length} models | ${typePrices.length} types | priceFrom: ${formatPrice(priceFrom)}`);
      await sleep(800);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n[minto] Done — ${builds.length} communities`);
  return builds;
}
