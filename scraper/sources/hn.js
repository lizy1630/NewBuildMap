/**
 * Scraper for HN Homes — hnhomes.com
 *
 * Communities: Kanata Lakes (Kanata), Riverside South (Barrhaven)
 *
 * Scrapes per community:
 *   - /townhomes.html          → Townhome models (name, sqft, image; beds/baths = 3 placeholder)
 *   - /singles.html            → Single Family models (name, sqft, image, lotWidth; beds/baths = 3 placeholder)
 *   - /features.html           → Included features list
 *   - /pricelist-singles.html  → Dated PDF price report for singles
 *   - /pricelist-townhomes.html → Dated PDF price report for townhomes (Riverside South only)
 *
 * Notes:
 *   - Bed/bath counts not shown on site; all models default to beds=3, baths=3 for manual review
 *   - Townhome model variants (2/3/4-bed) deduplicated by name; 3-bed image preferred
 *   - PDF reports stamped with scrape date for historical price comparison
 *   - taxIncluded = true (prices shown include HST rebate)
 */
import { chromium } from 'playwright-core';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import axios from 'axios';
import { formatPrice, slugify, sleep } from '../utils.js';

const BASE_URL    = 'https://hnhomes.com';
const REPORTS_DIR = new URL('../../public/data/hn-price-reports', import.meta.url).pathname;
const IMAGES_DIR  = new URL('../../public/images/hn', import.meta.url).pathname;

// ── Communities ───────────────────────────────────────────────────────────────

const KNOWN_COMMUNITIES = [
  {
    id:               'hn-kanata-lakes',
    slug:             'kanata-lakes',
    displayName:      'Kanata Lakes',
    neighbourhood:    'Kanata',
    lat:              45.3250,
    lng:              -75.9133,
    hasTownPricelist: false,
  },
  {
    id:               'hn-riverside-south',
    slug:             'riverside-south',
    displayName:      'Riverside South',
    neighbourhood:    'Barrhaven',
    lat:              45.2750,
    lng:              -75.6950,
    hasTownPricelist: true,
  },
];

// ── Image download ────────────────────────────────────────────────────────────

async function downloadImage(remoteUrl, commSlug, fileKey) {
  if (!remoteUrl) return null;
  mkdirSync(`${IMAGES_DIR}/${commSlug}`, { recursive: true });
  const rawExt = (remoteUrl.split('.').pop().split('?')[0] || 'jpg').toLowerCase();
  const ext    = ['jpg', 'jpeg', 'png', 'webp'].includes(rawExt) ? rawExt : 'jpg';
  const dest   = `${IMAGES_DIR}/${commSlug}/${fileKey}.${ext}`;
  const pub    = `/images/hn/${commSlug}/${fileKey}.${ext}`;
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

// ── Page loader ───────────────────────────────────────────────────────────────

async function loadPage(browser, url) {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    return page;
  } catch (err) {
    await page.close();
    throw err;
  }
}

// ── Scrape townhomes ──────────────────────────────────────────────────────────

async function scrapeTownhomes(browser, slug) {
  const url = `${BASE_URL}/communities/${slug}/townhomes.html`;
  console.log(`  [hn] Scraping townhomes: ${url}`);
  const page = await loadPage(browser, url);

  const raw = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('a[href*="/floorplan/townhomes/"]').forEach(el => {
      // Use el.href for absolute URL (browser resolves it)
      const href   = el.href || '';
      const imgEl  = el.querySelector('img');
      const imgSrc = imgEl?.src || '';  // .src returns absolute URL in browser context
      const text   = el.textContent.replace(/\s+/g, ' ').trim();

      // Model name: "The Parkway"
      const nameMatch = text.match(/\bThe\s+([A-Z][a-z]+)\b/);
      const name = nameMatch ? `The ${nameMatch[1]}` : null;
      if (!name) return;

      // Sqft: "2,523 SQ. FT."
      const sqftMatch = text.match(/([\d,]+)\s*SQ\.?\s*FT/i);
      const sqft = sqftMatch ? parseInt(sqftMatch[1].replace(/,/g, ''), 10) : null;

      // Bed count from URL path: /townhomes/3/parkway.html → 3
      const bedsMatch = href.match(/\/townhomes\/(\d+)\//);
      const bedsFromUrl = bedsMatch ? parseInt(bedsMatch[1]) : null;

      items.push({ name, sqft, imageUrl: imgSrc, bedsFromUrl, modelUrl: href });
    });
    return items;
  });

  await page.close();

  // Deduplicate by model name — prefer 3-bed image variant, fallback to first found
  const byName = new Map();
  for (const m of raw) {
    if (!byName.has(m.name) || m.bedsFromUrl === 3) {
      byName.set(m.name, m);
    }
  }
  return [...byName.values()];
}

// ── Scrape singles ────────────────────────────────────────────────────────────

async function scrapeSingles(browser, slug) {
  const url = `${BASE_URL}/communities/${slug}/singles.html`;
  console.log(`  [hn] Scraping singles: ${url}`);
  const page = await loadPage(browser, url);

  const raw = await page.evaluate(() => {
    const seen  = new Set();
    const items = [];
    document.querySelectorAll('a[href*="/floorplan/singles/"]').forEach(el => {
      const href   = el.href || '';
      const imgEl  = el.querySelector('img');
      const imgSrc = imgEl?.src || '';
      const text   = el.textContent.replace(/\s+/g, ' ').trim();

      const nameMatch = text.match(/\bThe\s+([A-Z][a-z]+)\b/);
      const name = nameMatch ? `The ${nameMatch[1]}` : null;
      if (!name || seen.has(name)) return;
      seen.add(name);

      // Sqft — first number before "SQ. FT." (some models show "2,173/2,183", take first)
      const sqftMatch = text.match(/([\d,]+)\s*(?:\/[\d,]+)?\s*SQ\.?\s*FT/i);
      const sqft = sqftMatch ? parseInt(sqftMatch[1].replace(/,/g, ''), 10) : null;

      // Lot width from URL: /floorplan/singles/35/hawkeswood.html → 35
      const lotMatch = href.match(/\/singles\/(\d+)\//);
      const lotWidth = lotMatch ? parseInt(lotMatch[1]) : null;

      items.push({ name, sqft, lotWidth, imageUrl: imgSrc, modelUrl: href });
    });
    return items;
  });

  await page.close();
  return raw;
}

// ── Scrape features ───────────────────────────────────────────────────────────

async function scrapeFeatures(browser, slug) {
  const url = `${BASE_URL}/communities/${slug}/features.html`;
  console.log(`  [hn] Scraping features: ${url}`);
  const page = await loadPage(browser, url);

  const features = await page.evaluate(() => {
    const main = document.querySelector('main, article, .content, .features-content') || document.body;
    const items = [];
    main.querySelectorAll('li, p').forEach(el => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text.length >= 20 && text.length <= 250) {
        if (!/^(home|communities|back to top|sign up|register|contact|privacy|terms|menu)/i.test(text)) {
          items.push(text);
        }
      }
    });
    return [...new Set(items)].slice(0, 100);
  });

  await page.close();
  return features;
}

// ── Scrape pricelist → structured sections ────────────────────────────────────

async function scrapePricelist(browser, slug, type) {
  const url = `${BASE_URL}/communities/${slug}/pricelist-${type}.html`;
  console.log(`  [hn] Pricelist (${type}): ${url}`);

  let page;
  try {
    page = await loadPage(browser, url);
  } catch {
    return null;
  }

  // Bail if page has no price data (handles redirected 404s)
  const hasPrices = await page.evaluate(() =>
    /\$[\d,]{4,}/.test(document.body.textContent)
  );
  if (!hasPrices) {
    await page.close();
    return null;
  }

  const sections = await page.evaluate(() => {
    const result  = [];
    let current   = null;

    function newSection(heading) {
      current = { heading, rows: [] };
      result.push(current);
    }

    const skipTags = new Set(['nav', 'header', 'footer', 'script', 'style']);

    function walk(node) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (skipTags.has(tag)) return;

      if (['h2', 'h3', 'h4'].includes(tag)) {
        const text = node.textContent.replace(/\s+/g, ' ').trim();
        if (text.length > 2 && text.length < 120) newSection(text);
        return; // don't walk into headings
      }

      if (tag === 'table') {
        if (!current) newSection('Pricing');
        node.querySelectorAll('tr').forEach(tr => {
          const cells = [...tr.querySelectorAll('td, th')]
            .map(td => td.textContent.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          if (cells.length >= 2) current.rows.push(cells);
        });
        return; // don't recurse into table — already handled
      }

      [...node.children].forEach(walk);
    }

    walk(document.body);

    // Fallback: if no tables found, look for div-rows with prices
    const hasTableData = result.some(s => s.rows.length > 0);
    if (!hasTableData) {
      newSection('Pricing');
      document.querySelectorAll('[class*="row"], [class*="item"]').forEach(el => {
        if (!/\$[\d,]/.test(el.textContent)) return;
        const cells = [...el.querySelectorAll('span, div')]
          .map(c => c.textContent.replace(/\s+/g, ' ').trim())
          .filter(c => c.length > 0 && c.length < 100);
        if (cells.length >= 2) current.rows.push(cells);
      });
    }

    return result.filter(s => s.rows.some(r => /\$[\d,]/.test(r.join(''))));
  });

  await page.close();
  return sections?.length ? sections : null;
}

// ── Extract minimum price from pricelist sections ─────────────────────────────

function extractMinPrice(sections) {
  if (!sections) return null;
  let min = Infinity;
  for (const section of sections) {
    for (const row of section.rows) {
      for (const cell of row) {
        const m = cell.replace(/,/g, '').match(/\$(\d{6,7})/);
        if (m) {
          const p = parseInt(m[1], 10);
          if (p > 500000 && p < min) min = p;
        }
      }
    }
  }
  return min < Infinity ? min : null;
}

// ── PDF price report ──────────────────────────────────────────────────────────

async function generatePriceReport(browser, communityName, homeType, sections, date) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const safeDate = date.replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${slugify(communityName)}-${slugify(homeType)}-${safeDate}.pdf`;
  const outPath  = `${REPORTS_DIR}/${filename}`;
  const pubPath  = `/data/hn-price-reports/${filename}`;
  if (existsSync(outPath)) return pubPath;

  const sectionsHtml = sections.map(s => {
    const rowsHtml = s.rows.map(cells => {
      const hasPrice = cells.some(c => /\$[\d,]{4,}/.test(c));
      if (!hasPrice) {
        // Treat as header row
        return `<tr><th>${cells.map(c => `${c}`).join('</th><th>')}</th></tr>`;
      }
      return `<tr><td>${cells.map(c => `${c}`).join('</td><td>')}</td></tr>`;
    }).join('');
    return `
      <div class="section">
        <h2>${s.heading}</h2>
        <table><tbody>${rowsHtml}</tbody></table>
      </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 10px; margin: 20px; color: #1a1a1a; }
  h1   { font-size: 15px; margin-bottom: 3px; color: #2c3e50; }
  h2   { font-size: 11px; margin: 14px 0 4px; color: #2c3e50; border-bottom: 1px solid #bbb; padding-bottom: 2px; }
  .meta { color: #777; font-size: 9px; margin-bottom: 14px; }
  .section { margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #2c3e50; color: #fff; padding: 5px 8px; text-align: left; font-size: 9px; }
  td { padding: 4px 8px; border-bottom: 1px solid #eee; }
  tr:nth-child(even) td { background: #f9f9f9; }
  tr:hover td { background: #eef4fb; }
</style>
</head>
<body>
<h1>HN Homes – ${communityName} | ${homeType} Price Report</h1>
<div class="meta">Generated: ${date} &nbsp;·&nbsp; Source: hnhomes.com &nbsp;·&nbsp; Prices include HST rebate</div>
${sectionsHtml}
</body>
</html>`;

  const pdfPage = await browser.newPage();
  await pdfPage.setContent(html, { waitUntil: 'load' });
  await pdfPage.pdf({
    path: outPath, format: 'A4', printBackground: true,
    margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
  });
  await pdfPage.close();
  console.log(`  [hn] PDF saved: ${filename}`);
  return pubPath;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function scrape() {
  console.log('[hn] Starting HN Homes scrape...');
  const browser = await chromium.launch({ headless: true });
  const builds  = [];
  const date    = new Date().toISOString();

  try {
    for (const comm of KNOWN_COMMUNITIES) {
      console.log(`\n[hn] ${comm.displayName}`);
      const commSlug = slugify(comm.displayName);

      // 1. Scrape models
      let townhomeModels = [], singleModels = [];

      try {
        townhomeModels = await scrapeTownhomes(browser, comm.slug);
        console.log(`  → ${townhomeModels.length} townhome models`);
        await sleep(600);
      } catch (err) {
        console.warn(`  [hn] Townhomes failed: ${err.message}`);
      }

      try {
        singleModels = await scrapeSingles(browser, comm.slug);
        console.log(`  → ${singleModels.length} single family models`);
        await sleep(600);
      } catch (err) {
        console.warn(`  [hn] Singles failed: ${err.message}`);
      }

      // 2. Download images
      for (const m of townhomeModels) {
        if (m.imageUrl) {
          m.localImageUrl = await downloadImage(m.imageUrl, commSlug, `${slugify(m.name)}-town`);
          await sleep(80);
        }
      }
      for (const m of singleModels) {
        if (m.imageUrl) {
          m.localImageUrl = await downloadImage(m.imageUrl, commSlug, `${slugify(m.name)}-single`);
          await sleep(80);
        }
      }

      // 3. Scrape features
      let includedFeatures = [];
      try {
        includedFeatures = await scrapeFeatures(browser, comm.slug);
        console.log(`  → ${includedFeatures.length} features`);
        await sleep(400);
      } catch (err) {
        console.warn(`  [hn] Features failed: ${err.message}`);
      }

      // 4. Scrape pricelists + generate PDFs
      const typePrices    = [];
      const featureSheets = [{
        name: `HN Homes - ${comm.displayName} - Feature Sheet`,
        url:  `${BASE_URL}/communities/${comm.slug}/features.html`,
      }];
      let priceReportUrl = null;

      // Singles pricelist (always attempted)
      try {
        const data = await scrapePricelist(browser, comm.slug, 'singles');
        if (data) {
          const minPrice = extractMinPrice(data);
          if (minPrice) typePrices.push({
            type: "Single Family",
            priceFrom: minPrice,
            priceFromFormatted: formatPrice(minPrice),
          });
          const rptUrl = await generatePriceReport(browser, comm.displayName, 'Singles', data, date);
          if (rptUrl) {
            priceReportUrl = rptUrl;
            featureSheets.push({ name: `HN Homes - ${comm.displayName} - Singles Price Report`, url: rptUrl });
          }
        }
        await sleep(400);
      } catch (err) {
        console.warn(`  [hn] Singles pricelist failed: ${err.message}`);
      }

      // Townhomes pricelist (where available)
      if (comm.hasTownPricelist) {
        try {
          const data = await scrapePricelist(browser, comm.slug, 'townhomes');
          if (data) {
            const minPrice = extractMinPrice(data);
            if (minPrice) typePrices.push({
              type: 'Townhomes',
              priceFrom: minPrice,
              priceFromFormatted: formatPrice(minPrice),
            });
            const rptUrl = await generatePriceReport(browser, comm.displayName, 'Townhomes', data, date);
            if (rptUrl) {
              if (!priceReportUrl) priceReportUrl = rptUrl;
              featureSheets.push({ name: `HN Homes - ${comm.displayName} - Townhomes Price Report`, url: rptUrl });
            }
          }
          await sleep(400);
        } catch (err) {
          console.warn(`  [hn] Townhomes pricelist failed: ${err.message}`);
        }
      }

      // 5. Assemble models
      const models = [
        ...townhomeModels.map(m => ({
          name:          m.name,
          type:          'Townhomes',
          sqft:          m.sqft,
          beds:          3,     // placeholder — site does not show; fill manually
          baths:         3,     // placeholder
          garages:       null,
          lotWidth:      null,
          priceFrom:     null,
          available:     true,
          localImageUrl: m.localImageUrl || null,
          modelUrl:      m.modelUrl,
        })),
        ...singleModels.map(m => ({
          name:          m.name,
          type:          'Single Family',
          sqft:          m.sqft,
          beds:          3,     // placeholder
          baths:         3,     // placeholder
          garages:       null,
          lotWidth:      m.lotWidth,
          priceFrom:     null,
          available:     true,
          localImageUrl: m.localImageUrl || null,
          modelUrl:      m.modelUrl,
        })),
      ];

      const homeTypes = [];
      if (townhomeModels.length) homeTypes.push('Townhomes');
      if (singleModels.length)   homeTypes.push('Single Family');
      const mapType = homeTypes.includes('Single Family') && homeTypes.includes('Townhomes') ? 'mixed'
                    : homeTypes.includes('Townhomes') ? 'townhouse'
                    : 'single-family';

      const allPrices = typePrices.map(t => t.priceFrom).filter(Boolean);
      const priceFrom = allPrices.length ? Math.min(...allPrices) : null;

      builds.push({
        id:                  comm.id,
        name:                comm.displayName,
        builder:             'HN Homes',
        community:           comm.neighbourhood,
        address:             `${comm.displayName}, ${comm.neighbourhood}, Ottawa, ON`,
        lat:                 comm.lat,
        lng:                 comm.lng,
        homeTypes,
        type:                mapType,
        models,
        typePrices,
        priceFrom,
        priceFromFormatted:  formatPrice(priceFrom),
        taxIncluded:         true,
        featureSheets,
        includedFeatures,
        priceReportUrl,
        status:              'selling',
        completionYear:      null,
        description:         `An HN Homes community in ${comm.neighbourhood}, Ottawa.`,
        sourceUrl:           `${BASE_URL}/communities/${comm.slug}/`,
        sourceName:          'hnhomes.com',
        imageUrl:            '',
        scrapedAt:           date,
      });

      console.log(`  ✓ ${models.length} models | priceFrom: ${formatPrice(priceFrom)} | ${featureSheets.length} sheets`);
      await sleep(800);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n[hn] Done — ${builds.length} communities`);
  return builds;
}
