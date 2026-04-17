/**
 * Scraper for Cardel Homes Ottawa — cardelhomes.com
 *
 * Communities (hardcoded, Ottawa only):
 *   - Ironwood     (Riverside South)  — Essential Towns, Executive Towns, 34'/38' Singles
 *   - Edenwylde    (Stittsville)      — Terrace Towns
 *
 * Floorplans are on www1.cardelhomes.com/ontario/<slug>/homes
 * (linked via the "Floorplans" nav on the community page).
 *
 * Model name rules:
 *   - "AZURE - INTERIOR"  → "Azure"       (Interior variant — drop suffix per spec)
 *   - "SAPPHIRE 2 - END UNIT" → "Sapphire 2 End"  (End Unit — append "End")
 *   - "COBALT"            → "Cobalt"      (no variant — title-case the slug)
 *
 * Bed display rules:
 *   - "3 BEDS"   → beds=3, display "3"
 *   - "3 - 4 BEDS" → bedsMin=3, bedsMax=4, display "3 (opt 4)"
 *
 * Lot width: parsed from section heading "34' LOT SINGLE-FAMILY HOMES" → 34
 * Garages:   inferred — townhome sections → 1, single-family sections → 2
 * taxIncluded = true  (prices shown include HST rebate)
 * priceFrom per section = min price of available models in that section
 */
import { chromium } from 'playwright-core';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import axios from 'axios';
import { formatPrice, slugify, sleep } from '../utils.js';

const BASE_URL    = 'https://www1.cardelhomes.com';
const REPORTS_DIR = new URL('../../public/data/cardel-price-reports', import.meta.url).pathname;
const IMAGES_DIR  = new URL('../../public/images/cardel', import.meta.url).pathname;

// ── Known communities ─────────────────────────────────────────────────────────

const KNOWN_COMMUNITIES = [
  {
    id:           'cardel-ironwood',
    slug:         'ironwood',
    displayName:  'Ironwood',
    neighbourhood:'Riverside South',
    address:      '801 Kenny Gordon Avenue, Riverside South, Ottawa, ON K4M 0N4',
    lat:          45.2636,
    lng:          -75.6852,
    sourceUrl:    'https://www.cardelhomes.com/ottawa/communities/ironwood',
  },
  {
    id:           'cardel-edenwylde',
    slug:         'edenwylde',
    displayName:  'EdenWylde',
    neighbourhood:'Stittsville',
    address:      'EdenWylde, Stittsville, Ottawa, ON',
    lat:          45.2640,
    lng:          -75.9370,
    sourceUrl:    'https://www.cardelhomes.com/ottawa/communities/edenwylde',
  },
];

// ── Name normalization from URL slug ──────────────────────────────────────────

/**
 * Convert href slug to display name, applying Interior/End Unit rules.
 *  "cobalt"              → "Cobalt"
 *  "azure-interior"      → "Azure"
 *  "sapphire-2-end-unit" → "Sapphire 2 End"
 */
function slugToModelName(slug) {
  let base = slug;
  let suffix = '';

  if (base.endsWith('-interior')) {
    base = base.slice(0, -'-interior'.length);
    // Interior → just use base name (drop suffix)
  } else if (base.endsWith('-end-unit')) {
    base = base.slice(0, -'-end-unit'.length);
    suffix = ' End';
  } else if (base.endsWith('-end')) {
    base = base.slice(0, -'-end'.length);
    suffix = ' End';
  }

  const name = base
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  return name + suffix;
}

// ── Spec parsing ──────────────────────────────────────────────────────────────

/**
 * Parse "1,571 - 1,895 SQ FT | 3 - 4 BEDS | 2.5 - 3.5 BATHS"
 * Returns { sqft, sqftMax, bedsMin, bedsMax, bathsMin, bathsMax }
 */
function parseSpec(spec) {
  if (!spec) return {};

  // sqft — first number group before SQ FT
  const sqftM = spec.match(/([\d,]+)(?:\s*[-–]\s*[\d,]+)?\s*SQ\.?\s*FT/i);
  const sqft  = sqftM ? parseInt(sqftM[1].replace(/,/g, ''), 10) : null;
  const sqftM2 = spec.match(/[\d,]+\s*[-–]\s*([\d,]+)\s*SQ\.?\s*FT/i);
  const sqftMax = sqftM2 ? parseInt(sqftM2[1].replace(/,/g, ''), 10) : null;

  // beds
  const bedsM   = spec.match(/([\d]+)(?:\s*[-–]\s*([\d]+))?\s*BED/i);
  const bedsMin  = bedsM ? parseInt(bedsM[1]) : null;
  const bedsMax  = bedsM?.[2] ? parseInt(bedsM[2]) : null;

  // baths
  const bathsM  = spec.match(/([\d.]+)(?:\s*[-–]\s*([\d.]+))?\s*BATH/i);
  const bathsMin = bathsM ? parseFloat(bathsM[1]) : null;
  const bathsMax = bathsM?.[2] ? parseFloat(bathsM[2]) : null;

  return { sqft, sqftMax, bedsMin, bedsMax, bathsMin, bathsMax };
}

/**
 * Build bed display label.
 *   bedsMin=3, bedsMax=5 → "3 (opt 5)"
 *   bedsMin=3, bedsMax=null → 3
 */
function bedLabel(bedsMin, bedsMax) {
  if (bedsMin == null) return null;
  if (bedsMax != null && bedsMax !== bedsMin) {
    return `${bedsMin} (opt ${bedsMax})`;
  }
  return bedsMin;
}

// ── Section → type helpers ────────────────────────────────────────────────────

function sectionToHomeType(section) {
  const s = section.toLowerCase();
  if (s.includes('town') || s.includes('terrace')) return 'Townhomes';
  return 'Single Family';
}

function sectionToLotWidth(section) {
  const m = section.match(/(\d+)[''′]\s*LOT/i);
  return m ? parseInt(m[1], 10) : null;
}

function sectionToGarages(section) {
  const s = section.toLowerCase();
  if (s.includes('town') || s.includes('terrace')) return 1;
  return 2;
}

// ── Image download ────────────────────────────────────────────────────────────

async function downloadImage(remoteUrl, commSlug, modelSlug) {
  if (!remoteUrl) return null;
  mkdirSync(`${IMAGES_DIR}/${commSlug}`, { recursive: true });
  // Prefer 640x640 version
  const url640 = remoteUrl.replace(/_\d+x\d+(\.\w+)$/, '_640x640$1');
  const rawExt = (url640.split('.').pop().split('?')[0] || 'webp').toLowerCase();
  const ext    = ['jpg', 'jpeg', 'png', 'webp'].includes(rawExt) ? rawExt : 'webp';
  const dest   = `${IMAGES_DIR}/${commSlug}/${modelSlug}.${ext}`;
  const pub    = `/images/cardel/${commSlug}/${modelSlug}.${ext}`;
  if (existsSync(dest)) return pub;
  try {
    const res = await axios.get(url640, {
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
    return remoteUrl; // fallback to remote
  }
}

// ── PDF price report ──────────────────────────────────────────────────────────

async function generatePriceReport(browser, communityName, sectionGroups, date) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const safeDate = date.replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${slugify(communityName)}-${safeDate}.pdf`;
  const outPath  = `${REPORTS_DIR}/${filename}`;
  const pubPath  = `/data/cardel-price-reports/${filename}`;
  if (existsSync(outPath)) return pubPath;

  const sectionsHtml = sectionGroups.map(({ section, models }) => {
    const fromPrices = models.filter(m => m.available && m.priceFrom).map(m => m.priceFrom);
    const fromPrice  = fromPrices.length ? Math.min(...fromPrices) : null;

    const rows = models.map(m => {
      const imgHtml = m.localImageUrl
        ? `<img src="${m.localImageUrl}" width="80" height="55" style="object-fit:cover;border-radius:3px">`
        : '<span style="color:#ccc;font-size:9px">No image</span>';
      const wasHtml = m.wasPrice
        ? `<span style="text-decoration:line-through;color:#aaa;font-size:9px">$${m.wasPrice.toLocaleString('en-CA')}</span> `
        : '';
      const priceHtml = m.available && m.priceFrom
        ? `${wasHtml}<strong>$${m.priceFrom.toLocaleString('en-CA')}</strong>`
        : (!m.available ? '<span style="color:#bbb">Coming Soon</span>' : '—');
      const bedsDisplay = typeof m.beds === 'string' ? m.beds : (m.beds ?? '—');
      return `
        <tr>
          <td>${imgHtml}</td>
          <td><strong>${m.name}</strong></td>
          <td>${m.sqft ? m.sqft.toLocaleString() + ' sq.ft.' : '—'}</td>
          <td>${bedsDisplay} bd / ${m.baths ?? '—'} ba</td>
          <td>${m.garages ?? '—'} gar${m.lotWidth ? ` / ${m.lotWidth}′ lot` : ''}</td>
          <td>${priceHtml}</td>
        </tr>`;
    }).join('');

    return `
      <div class="section">
        <div class="section-header">
          <span class="section-name">${section}</span>
          ${fromPrice ? `<span class="from-price">From $${fromPrice.toLocaleString('en-CA')} <span class="hst">incl. HST rebate</span></span>` : ''}
        </div>
        <table>
          <thead><tr><th>Image</th><th>Model</th><th>Size</th><th>Beds/Baths</th><th>Gar/Lot</th><th>Price (incl. HST rebate)</th></tr></thead>
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
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10px; margin: 0; padding: 20px; color: #1a1a1a; }
  h1   { font-size: 15px; font-weight: 700; margin: 0 0 2px; color: #c0392b; }
  .meta { font-size: 9px; color: #888; margin-bottom: 18px; }
  .section { margin-bottom: 18px; page-break-inside: avoid; }
  .section-header { display: flex; align-items: baseline; gap: 14px; margin-bottom: 5px; border-bottom: 2px solid #c0392b; padding-bottom: 3px; }
  .section-name { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #c0392b; }
  .from-price { font-size: 10px; font-weight: 600; color: #333; }
  .hst { font-size: 8px; color: #777; font-weight: 400; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #c0392b; color: #fff; padding: 5px 8px; text-align: left; font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
  td { padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: middle; }
  tr:nth-child(even) td { background: #fafafa; }
  td:last-child { font-weight: 600; }
</style>
</head>
<body>
<h1>Cardel Homes – ${communityName} | Price Report</h1>
<div class="meta">Generated: ${date} &nbsp;·&nbsp; Source: cardelhomes.com &nbsp;·&nbsp; All prices include HST rebate</div>
${sectionsHtml}
</body>
</html>`;

  const pg = await browser.newPage();
  await pg.setContent(html, { waitUntil: 'load' });
  await pg.pdf({
    path: outPath, format: 'A4', printBackground: true,
    margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' },
  });
  await pg.close();
  console.log(`  [cardel] PDF saved: ${filename}`);
  return pubPath;
}

// ── Scrape floorplans page ────────────────────────────────────────────────────

async function scrapeFloorplans(browser, slug) {
  const url = `${BASE_URL}/ontario/${slug}/homes`;
  console.log(`  [cardel] Loading: ${url}`);

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(3000);

  // Accept cookie banner
  await page.evaluate(() => {
    document.querySelectorAll('button').forEach(b => {
      if (/^accept$/i.test(b.textContent.trim())) b.click();
    });
  });
  await page.waitForTimeout(400);

  // Scroll to trigger lazy loading of plan images
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < height; y += 600) {
    await page.evaluate(y => window.scrollTo(0, y), y);
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(500);

  // Walk the DOM: collect H2 section headings + plan card links in order
  const sections = await page.evaluate((baseUrl) => {
    const result = [];
    let cur = null;

    function walk(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;

      if (el.tagName === 'H2' && el.className?.includes('uppercase')) {
        const txt = el.textContent.trim();
        if (txt && !txt.toLowerCase().includes('privacy') && !txt.toLowerCase().includes('sign up')) {
          cur = { section: txt, plans: [] };
          result.push(cur);
        }
        return;
      }

      if (cur && el.tagName === 'A') {
        const href = el.href || '';
        // Match /homes/<slug> — slug is lowercase letters/numbers/hyphens only
        if (/\/homes\/[a-z][a-z0-9-]+$/.test(href)) {
          const planSlug  = href.split('/homes/')[1];
          const priceEl   = el.querySelector('[class*="text-3xl"]');
          const wasEl     = el.querySelector('[class*="line-through"]');
          const img       = el.querySelector('img')?.src || '';
          // Spec line: "X SQ FT | X BEDS | X BATHS"
          const fullText  = el.innerText.replace(/\s+/g, ' ').trim();
          const specMatch = fullText.match(/([\d,]+(?:\s*[-–]\s*[\d,]+)?\s*SQ\.?\s*FT[^|]*(?:\|[^|]+){0,3})/i);
          const spec      = specMatch?.[0]?.trim() || '';
          const comingSoon = /COMING\s+SOON/i.test(fullText);
          const priceText = priceEl?.textContent?.replace(/[^\d]/g, '') || '';
          const wasText   = wasEl?.textContent?.replace(/[^\d]/g, '') || '';

          cur.plans.push({
            planSlug,
            href,
            img: img.replace(/_\d+x\d+(\.\w+)$/, '_640x640$1'),
            priceText,
            wasText,
            spec,
            comingSoon,
          });
        }
      }

      for (const child of el.children) walk(child);
    }

    walk(document.body);
    return result;
  }, BASE_URL);

  await page.close();
  return sections.filter(s => s.plans.length > 0);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function scrape() {
  console.log('[cardel] Starting Cardel Homes Ottawa scrape...');
  const browser = await chromium.launch({ headless: true });
  const builds  = [];
  const date    = new Date().toISOString();

  try {
    for (const comm of KNOWN_COMMUNITIES) {
      console.log(`\n[cardel] ${comm.displayName} (${comm.neighbourhood})`);

      let rawSections;
      try {
        rawSections = await scrapeFloorplans(browser, comm.slug);
        console.log(`  → ${rawSections.length} sections found`);
        await sleep(600);
      } catch (err) {
        console.warn(`  [cardel] Failed to scrape ${comm.slug}: ${err.message}`);
        continue;
      }

      if (!rawSections.length) {
        console.warn(`  [cardel] No sections found for ${comm.slug}`);
        continue;
      }

      // Process each section's plans
      const sectionGroups = [];
      const allModels     = [];
      const typePriceMap  = {};

      for (const sec of rawSections) {
        const lotWidth  = sectionToLotWidth(sec.section);
        const garages   = sectionToGarages(sec.section);
        const homeType  = sectionToHomeType(sec.section);

        const models = [];

        for (const plan of sec.plans) {
          const name      = slugToModelName(plan.planSlug);
          const modelSlug = slugify(name);
          const { sqft, bedsMin, bedsMax, bathsMin } = parseSpec(plan.spec);
          const priceFrom = plan.priceText ? parseInt(plan.priceText, 10) || null : null;
          const wasPrice  = plan.wasText   ? parseInt(plan.wasText,   10) || null : null;
          const available = !plan.comingSoon;

          // Download image
          let localImageUrl = null;
          if (plan.img) {
            localImageUrl = await downloadImage(plan.img, comm.slug, modelSlug);
            await sleep(60);
          }

          const model = {
            name,
            type:      homeType,
            sqft,
            beds:      bedLabel(bedsMin, bedsMax),   // string like "3 (opt 5)" or number
            baths:     bathsMin,
            garages,
            lotWidth,
            priceFrom: available ? priceFrom : null,
            wasPrice:  available ? wasPrice  : null,
            available,
            localImageUrl,
            modelUrl: plan.href,
          };

          models.push(model);
          allModels.push(model);

          // Track min price per type
          if (available && priceFrom) {
            if (!typePriceMap[sec.section] || priceFrom < typePriceMap[sec.section]) {
              typePriceMap[sec.section] = priceFrom;
            }
          }
        }

        sectionGroups.push({ section: sec.section, homeType, models });
        console.log(`    ${sec.section}: ${models.length} models`);
      }

      // Build typePrices array
      const typePrices = Object.entries(typePriceMap)
        .map(([type, priceFrom]) => ({ type, priceFrom, priceFromFormatted: formatPrice(priceFrom) }))
        .sort((a, b) => a.priceFrom - b.priceFrom);

      const allPrices = typePrices.map(t => t.priceFrom).filter(Boolean);
      const priceFrom = allPrices.length ? Math.min(...allPrices) : null;

      const homeTypes = [...new Set(allModels.map(m => m.type))];
      const hasSingle = homeTypes.includes('Single Family');
      const hasTown   = homeTypes.includes('Townhomes');
      const mapType   = hasSingle && hasTown ? 'mixed' : hasTown ? 'townhouse' : 'single-family';

      // Generate PDF
      let priceReportUrl = null;
      try {
        priceReportUrl = await generatePriceReport(browser, comm.displayName, sectionGroups, date);
      } catch (err) {
        console.warn(`  [cardel] PDF failed: ${err.message}`);
      }

      builds.push({
        id:                  comm.id,
        name:                comm.displayName,
        builder:             'Cardel Homes',
        community:           comm.neighbourhood,
        address:             comm.address,
        lat:                 comm.lat,
        lng:                 comm.lng,
        homeTypes,
        type:                mapType,
        models:              allModels,
        typePrices,
        priceFrom,
        priceFromFormatted:  formatPrice(priceFrom),
        taxIncluded:         true,
        featureSheets:       [],
        includedFeatures:    [],
        priceReportUrl,
        status:              'selling',
        completionYear:      null,
        description:         `A Cardel Homes community in ${comm.neighbourhood}, Ottawa.`,
        sourceUrl:           comm.sourceUrl,
        sourceName:          'cardelhomes.com',
        imageUrl:            '',
        scrapedAt:           date,
      });

      console.log(`  ✓ ${allModels.length} models | priceFrom: ${formatPrice(priceFrom)}`);
      typePrices.forEach(t => console.log(`    ${t.type}: ${t.priceFromFormatted}`));
      await sleep(800);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n[cardel] Done — ${builds.length} communities`);
  return builds;
}
