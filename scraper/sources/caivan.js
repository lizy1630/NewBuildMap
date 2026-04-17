/**
 * Scraper for Caivan Communities — caivan.com
 *
 * Uses Playwright (Cloudflare requires JS rendering).
 * One browser instance is shared for all page fetches.
 *
 * Ottawa communities:
 *   - Sold out  → skipped entirely
 *   - Coming soon → stub entry (homeTypes + status=upcoming, no models, no "View Details")
 *   - Now available → full model scrape from each collection's /plans/ page
 *
 * Model naming:
 *   "Series I / Plan 1"             → "S1/Plan1"
 *   "42′ Collection / The Chesley"  → "42′/The Chesley"
 *   "Two-Storey Freehold Towns / Plan 1 / 1E / 1C" → "Towns/Plan1/1E/1C"
 *
 * Type classification (per collection name):
 *   Contains "town" (case-insensitive) → townhouse
 *   Contains "summit"                  → townhouse  (stacked)
 *   Everything else                    → single-family
 */
import { chromium } from 'playwright-core';
import { geocode } from '../geocode.js';
import { slugify, sleep } from '../utils.js';

const BASE_URL    = 'https://caivan.com';
const LISTING_URL = `${BASE_URL}/communities/ottawa/`;

// ── Name helpers ─────────────────────────────────────────────────────────────

/** Shorten any name segment for use in a model label. */
function abbreviateSegment(raw) {
  const n = raw.trim();
  // Collection-level abbreviations
  if (/^Series\s+III$/i.test(n))               return 'S3';
  if (/^Series\s+II$/i.test(n))                return 'S2';
  if (/^Series\s+I$/i.test(n))                 return 'S1';
  const lotM = n.match(/^(\d+[′'])\s+[Cc]ollection$/i);
  if (lotM) return lotM[1];                    // "42′ Collection" → "42′"
  if (/two.storey\s+freehold\s+towns/i.test(n))  return 'Towns';
  if (/double\s+car\s+garage\s+towns/i.test(n))  return 'DCG Towns';
  if (/summit\s+series/i.test(n))              return 'Summit';
  if (/openplan/i.test(n))                     return 'OpenPlan';
  if (/ridgeview\s+collection/i.test(n))       return 'Ridgeview';
  // Sub-collection / residence type abbreviations
  if (/lower\s+residence/i.test(n))            return 'Lower';
  if (/upper\s+residence/i.test(n))            return 'Upper';
  if (/rear\s+lane/i.test(n))                  return 'Rear Lane';
  // Generic: strip trailing "Collection", leading "The"
  return n.replace(/\s+[Cc]ollection$/i, '').replace(/^The\s+/i, '').trim();
}

/**
 * Convert a full plan name like "Summit Series / Lower Residence / Plan 1"
 * into "Summit/Lower Plan 1".
 * - First segment → abbreviated collection prefix
 * - Middle segments → abbreviated (sub-collection / residence type)
 * - Last segment → kept as-is (plan name, spaces preserved)
 */
function formatModelName(fullName) {
  const parts = fullName.split('/').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return fullName;
  if (parts.length === 1) return abbreviateSegment(parts[0]);

  const prefix    = abbreviateSegment(parts[0]);
  const lastPart  = parts[parts.length - 1];               // e.g. "Plan 1"
  const midParts  = parts.slice(1, -1).map(abbreviateSegment); // e.g. ["Lower"]

  const middle = midParts.length ? midParts.join('/') + ' ' : '';
  return `${prefix}/${middle}${lastPart}`;
}

// ── Type helpers ─────────────────────────────────────────────────────────────

/** Map a collection name to a map-type bucket. */
function collectionToType(name) {
  const l = name.toLowerCase();
  if (l.includes('town') || l.includes('summit')) return 'townhouse';
  return 'single-family';
}

/**
 * Infer lot width from collection names like "42′ Collection" → 42.
 * Returns null if not determinable.
 */
function inferLotWidth(collectionName) {
  const m = collectionName.match(/(\d+)[′']/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Stat parsers ─────────────────────────────────────────────────────────────

function parseSqft(text) {
  if (!text) return null;
  const m = text.replace(/[,*]/g, '').match(/(\d{3,6})/);
  return m ? parseInt(m[1], 10) : null;
}

function parseBedsOrBaths(text) {
  if (!text) return null;
  // "Up to 4" or "4 (Optional up to 5)" → take the max value
  const nums = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
  return nums.length ? Math.max(...nums) : null;
}

// ── Approximate starting price from hero text ────────────────────────────────

function parseHeroPrice(text) {
  if (!text) return null;
  const exactM = text.match(/\$(\d[\d,]+)/);
  if (exactM) return parseInt(exactM[1].replace(/,/g, ''), 10);
  // "from the high $400s" / "from the $500s"
  const rangeM = text.match(/(low|mid|high)?\s*\$(\d+)s/i);
  if (!rangeM) return null;
  const base = parseInt(rangeM[2], 10) * 1000;
  const mod  = (rangeM[1] || '').toLowerCase();
  if (mod === 'high') return Math.round(base * 1.09);
  if (mod === 'mid')  return Math.round(base * 1.05);
  return base;
}

function formatPrice(n) {
  if (!n) return null;
  return '$' + Number(n).toLocaleString('en-CA');
}

/**
 * Derive a human-readable category label from a Features & Finishes PDF URL.
 * e.g. "Fox-Run-features-finishes-–-Singles.pdf" → "Singles"
 *      "Fox-Run-features-finishes-–-Townhomes.pdf" → "Townhomes"
 */
function featureSheetCategory(pdfUrl) {
  const decoded = decodeURIComponent(pdfUrl);
  const m = decoded.match(/features?[- –—]+finishes?[- –—]+([^/]+?)\.pdf$/i);
  if (m) return m[1].replace(/[-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
  // fallback: last path segment without extension
  return decoded.split('/').pop().replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
}

function featureSheetName(communityName, pdfUrl) {
  const cat = featureSheetCategory(pdfUrl);
  return `Caivan - ${communityName} - ${cat} - feature sheet`;
}

// ── Fallback coordinates for known communities ────────────────────────────────
// Used when OSM geocoding fails (rate-limit, etc.)

const KNOWN_COORDS = {
  // Richmond — 203 Meynell Rd, Richmond, ON K0A 2Z0
  'fox-run':         { lat: 45.1871, lng: -75.8493, community: 'Richmond Village' },
  // South Barrhaven — 3713 Borrisokane Rd, Ottawa, ON K2J 4J4
  'the-ridge':       { lat: 45.2440, lng: -75.7583, community: 'Barrhaven' },
  // South Barrhaven — 1033 Canoe St, Ottawa, ON K2J 0K6
  'the-conservancy': { lat: 45.2586, lng: -75.7552, community: 'Barrhaven' },
  // Orléans — 806 Mercier Cres, Orléans, ON K1W 0N5
  'orleans-village': { lat: 45.4402, lng: -75.5200, community: 'Orléans' },
  // West Stittsville — Hazeldean Rd / Carp Rd corridor (no civic address yet)
  'magnolia':        { lat: 45.2582, lng: -75.9348, community: 'Stittsville' },
  'barrhaven':       { lat: 45.2769, lng: -75.7590, community: 'Barrhaven' },
};

// ── Community slugify to build ID ────────────────────────────────────────────

function communityId(name) {
  return 'caivan-' + slugify(name);
}

// ── Playwright page fetch helper ─────────────────────────────────────────────

async function loadPage(browser, url) {
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    return page;
  } catch (err) {
    await page.close();
    throw err;
  }
}

// ── Step 1: Discover community slugs & statuses ───────────────────────────────

async function fetchCommunityList(browser) {
  console.log('[caivan] Fetching Ottawa community list...');
  const page = await loadPage(browser, LISTING_URL);

  // Each individual community card is .secondary-com-link inside .community-region-group
  // This gives one community per element — status is scoped to that element.
  const communities = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('.secondary-com-link').forEach(card => {
      const a = card.querySelector('a[href*="/ottawa/"]');
      if (!a) return;
      const href = a.href;
      if (!href || href.endsWith('/communities/ottawa/')) return;
      // Name from "Discover X" link text or image alt
      const discoverLink = [...card.querySelectorAll('a[href*="/ottawa/"]')]
        .find(el => /discover/i.test(el.textContent));
      const rawText = (discoverLink || a).textContent.trim();
      const name = rawText.replace(/^Discover\s+/i, '').trim();
      if (!name || name.length < 2) return;
      const status = card.querySelector('.community-status')?.textContent.trim() || '';
      results.push({ name, href, status });
    });
    return results;
  });

  // Deduplicate by href — prefer entries with a status
  const map = new Map();
  for (const c of communities) {
    if (!map.has(c.href) || (!map.get(c.href).status && c.status)) {
      map.set(c.href, c);
    }
  }

  await page.close();
  const list = [...map.values()];
  console.log(`[caivan] Found ${list.length} communities: ${list.map(c => `${c.name}(${c.status||'?'})`).join(', ')}`);
  return list;
}

// ── Step 2: Scrape a single community page ────────────────────────────────────

async function scrapeCommunityPage(browser, communityUrl) {
  const page = await loadPage(browser, communityUrl);

  // Address from contact block
  const addressText = await page.$eval(
    '[class*="contact-block"], [class*="sales-centre"], [class*="contact-group"]',
    el => el.innerText.replace(/\s+/g, ' ').trim()
  ).catch(() => '');

  // Extract "123 Some St. City, ON [PostalCode]" — stop at phone number or extra text
  const addrM = addressText.match(
    /(\d+\s+[A-Za-z][^.!\n]+(?:Rd|St|Ave|Blvd|Dr|Way|Cres|Ln|Ct|Pl|Mews|Pvt)\.?\s+[A-Za-z][^,\n]+,\s*ON\b\s*[A-Z]\d[A-Z]\s*\d[A-Z]\d)/i
  ) || addressText.match(
    /(\d+\s+[A-Za-z][^.!\n]+(?:Rd|St|Ave|Blvd|Dr|Way|Cres|Ln|Ct|Pl|Mews|Pvt)\.?\s+[A-Za-z][^,\n]+,\s*ON\b)/i
  );
  const address = addrM ? addrM[1].replace(/\s+/g, ' ').trim() : '';

  // Hero text (approx prices)
  const heroText = await page.$eval('[class*="hero"], [class*="banner"], h1, [class*="headline"]',
    el => el.innerText.replace(/\s+/g, ' ').trim()
  ).catch(() => '');

  // All collection links → { name, href, priceFrom, priceFromFormatted }
  const collections = await page.$$eval('.collection-link', els => els.map(el => {
    const link = el.querySelector('a');
    const name = el.querySelector('.font-display-3, .font-display-4, h2, h3, [class*="display"]')?.textContent.trim() || '';
    const priceText = el.querySelector('.font-label, [class*="font-label"]')?.textContent.trim() || '';
    const priceM = priceText.match(/\$([\d,]+)/);
    const priceFrom = priceM ? parseInt(priceM[1].replace(/,/g, ''), 10) : null;
    return {
      name,
      href: link?.href || null,
      priceFrom,
      priceFromFormatted: priceFrom ? '$' + priceFrom.toLocaleString('en-CA') : null,
    };
  })).then(cs => cs.filter(c => c.name));

  // Description
  const description = await page.$eval(
    '[class*="intro"] p, [class*="description"] p, .text p',
    el => el.textContent.trim()
  ).catch(() => '');

  await page.close();
  return { address, heroText, collections, description };
}

// ── Step 3: Scrape a collection page → array of models ───────────────────────

async function scrapeCollectionPage(browser, collectionUrl, collectionName) {
  let page;
  try {
    page = await loadPage(browser, collectionUrl);
  } catch (err) {
    console.warn(`  [caivan] Could not load ${collectionUrl}: ${err.message}`);
    return [];
  }

  const lotWidth = inferLotWidth(collectionName);
  const type     = collectionToType(collectionName);

  // All plan sections are in the DOM (shown/hidden by JS, but present)
  const models = await page.$$eval('section.plan', (els, { lotWidth, type, formatModelNameStr }) => {
    // Re-implement format fn inside browser context (no closures across context boundary)
    function fmt(fullName) {
      function abbrev(n) {
        n = n.trim();
        if (/^Series\s+III$/i.test(n))              return 'S3';
        if (/^Series\s+II$/i.test(n))               return 'S2';
        if (/^Series\s+I$/i.test(n))                return 'S1';
        const lotM = n.match(/^(\d+[′'])\s+[Cc]ollection$/i);
        if (lotM) return lotM[1];
        if (/two.storey\s+freehold\s+towns/i.test(n)) return 'Towns';
        if (/double\s+car\s+garage\s+towns/i.test(n)) return 'DCG Towns';
        if (/summit\s+series/i.test(n))             return 'Summit';
        if (/openplan/i.test(n))                    return 'OpenPlan';
        if (/ridgeview\s+collection/i.test(n))      return 'Ridgeview';
        if (/lower\s+residence/i.test(n))           return 'Lower';
        if (/upper\s+residence/i.test(n))           return 'Upper';
        if (/rear\s+lane/i.test(n))                 return 'Rear Lane';
        return n.replace(/\s+[Cc]ollection$/i, '').replace(/^The\s+/i, '').trim();
      }
      const parts = fullName.split('/').map(s => s.trim()).filter(Boolean);
      if (!parts.length) return fullName;
      if (parts.length === 1) return abbrev(parts[0]);
      const prefix   = abbrev(parts[0]);
      const lastPart = parts[parts.length - 1];
      const midParts = parts.slice(1, -1).map(abbrev);
      const middle   = midParts.length ? midParts.join('/') + ' ' : '';
      return `${prefix}/${middle}${lastPart}`;
    }

    return els.map(el => {
      const fullName = el.querySelector('h3')?.textContent.trim() || '';
      const name     = fmt(fullName);

      // Stat rows: "Square Feet1,895*" / "BedroomsUp to 4" etc.
      const statRows = [...el.querySelectorAll('.stat-row')]
        .map(r => r.textContent.trim().replace(/\s+/g, ' '));

      const sqftRow  = statRows.find(r => /square\s*feet/i.test(r)) || '';
      const bedsRow  = statRows.find(r => /bedroom/i.test(r)) || '';
      const bathsRow = statRows.find(r => /bathroom/i.test(r)) || '';

      // Parse sqft: strip non-digits except comma, find 3-6 digit number
      const sqftM = sqftRow.replace(/[,*]/g, '').match(/(\d{3,6})/);
      const sqft  = sqftM ? parseInt(sqftM[1], 10) : null;

      // Parse beds/baths: take max numeric value in string
      function maxNum(s) {
        const nums = [...s.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]));
        return nums.length ? Math.max(...nums) : null;
      }
      const beds  = maxNum(bedsRow);
      const baths = maxNum(bathsRow);

      // First elevation image
      const img = el.querySelector('.collection-images img')?.src || null;

      // Floor plan PDF download link
      const pdfLink = el.querySelector('a[href$=".pdf"]')?.href || null;

      return { name, type, sqft, beds, baths, lotWidth, garages: null, priceFrom: null,
               localImageUrl: img, modelUrl: pdfLink };
    }).filter(m => m.name);
  }, { lotWidth, type });

  // "Included Premium Features" bullet list
  const includedFeatures = await page.evaluate(() => {
    const allText = document.body.innerText;
    const idx = allText.indexOf('INCLUDED PREMIUM FEATURES');
    if (idx === -1) return [];
    const block = allText.slice(idx + 'INCLUDED PREMIUM FEATURES'.length, idx + 1200);
    return block.split('\n')
      .map(l => l.trim())
      .filter(l => l && !/^(DOWNLOAD|REGISTER|GET STARTED|EMAIL|CALL)/i.test(l))
      .slice(0, 20);
  });

  // Unique "Download Features & Finishes" PDF links on this page
  const featureSheetUrls = await page.evaluate(() => {
    return [...new Set(
      [...document.querySelectorAll('a[href$=".pdf"]')]
        .filter(a => /feature|finish/i.test(a.textContent + a.href))
        .map(a => a.href)
    )];
  });

  await page.close();
  return { models, includedFeatures, featureSheetUrls };
}

// ── Main scrape() export ──────────────────────────────────────────────────────

export async function scrape() {
  console.log('[caivan] Starting Ottawa scrape...');

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.error('[caivan] Failed to launch browser:', err.message);
    return [];
  }

  const builds = [];

  try {
    const communityList = await fetchCommunityList(browser);
    await sleep(500);

    for (const comm of communityList) {
      const statusLower = (comm.status || '').toLowerCase();

      // Skip sold-out communities
      if (statusLower.includes('sold')) {
        console.log(`[caivan] Skipping sold-out: ${comm.name}`);
        continue;
      }

      const isComingSoon = statusLower.includes('coming');
      const slug         = comm.href.replace(/.*\/ottawa\//, '').replace(/\/$/, '');
      const id           = `caivan-${slugify(slug)}`;

      console.log(`[caivan] Scraping ${comm.name} (${statusLower || 'unknown'})...`);

      let communityData;
      try {
        communityData = await scrapeCommunityPage(browser, comm.href);
      } catch (err) {
        console.error(`  [caivan] Failed community page for ${comm.name}: ${err.message}`);
        await sleep(500);
        continue;
      }
      await sleep(400);

      const { address, heroText, collections, description } = communityData;

      // Determine homeTypes from collection names
      const homeTypes = [];
      for (const col of collections) {
        if (!col.name) continue;
        const lower = col.name.toLowerCase();
        if (lower.includes('town') || lower.includes('summit')) {
          if (!homeTypes.includes('Townhomes')) homeTypes.push('Townhomes');
        } else {
          if (!homeTypes.includes('Single Family')) homeTypes.push('Single Family');
        }
      }

      // Determine overall map type
      const hasDetached = homeTypes.includes('Single Family');
      const hasTown     = homeTypes.includes('Townhomes');
      const mapType     = hasDetached && hasTown ? 'mixed'
                        : hasDetached ? 'single-family'
                        : hasTown ? 'townhouse'
                        : 'unknown';

      // Community of Ottawa neighborhood — use known-coords map or infer from URL
      const neighborhood = KNOWN_COORDS[slug]?.community
                         || (comm.href.includes('orleans') ? 'Orléans'
                         : comm.href.includes('conservancy') || comm.href.includes('ridge') || comm.href.includes('barrhaven') ? 'Barrhaven'
                         : comm.href.includes('stittsville') || comm.href.includes('magnolia') ? 'Stittsville'
                         : 'Ottawa');

      // Geocode — try live, fall back to hardcoded known coordinates
      let coords = { lat: null, lng: null };
      const fallback = KNOWN_COORDS[slug];
      if (address) {
        coords = await geocode(`${address}, Ottawa, ON, Canada`);
        await sleep(1200); // Nominatim rate-limit
      }
      if (!coords.lat && fallback) {
        coords = { lat: fallback.lat, lng: fallback.lng };
        console.log(`  [caivan] Using fallback coords for ${slug}`);
      }

      // Price from hero
      const priceFrom = parseHeroPrice(heroText);

      // ── Coming Soon: stub only, no models ──────────────────────────────────
      if (isComingSoon) {
        builds.push({
          id,
          name: comm.name,
          builder: 'Caivan',
          community: neighborhood,
          address: address || `${comm.name}, ${neighborhood}, Ottawa, ON`,
          lat: coords.lat,
          lng: coords.lng,
          homeTypes,
          type: mapType,
          models: [],
          priceFrom,
          priceFromFormatted: formatPrice(priceFrom),
          status: 'upcoming',
          completionYear: null,
          description: description || `A coming-soon Caivan community in ${neighborhood}, Ottawa.`,
          sourceUrl: comm.href,
          sourceName: 'caivan.com',
          imageUrl: '',
          scrapedAt: new Date().toISOString(),
        });
        console.log(`  [caivan] ${comm.name}: coming soon — ${homeTypes.join(', ')}`);
        await sleep(300);
        continue;
      }

      // ── Available: scrape each collection's plan page ──────────────────────
      const allModels = [];
      const allFeatureSheetUrls = new Set();
      let allIncludedFeatures = [];
      const exploreCollections = collections.filter(c => c.href && c.name);

      for (const col of exploreCollections) {
        console.log(`  [caivan] Scraping collection: ${col.name}`);
        try {
          const result = await scrapeCollectionPage(browser, col.href, col.name);
          allModels.push(...result.models);
          result.featureSheetUrls.forEach(u => allFeatureSheetUrls.add(u));
          if (result.includedFeatures.length && !allIncludedFeatures.length) {
            allIncludedFeatures = result.includedFeatures; // use first non-empty set
          }
          console.log(`    → ${result.models.length} plans, ${result.featureSheetUrls.length} feature PDFs`);
        } catch (err) {
          console.warn(`    [caivan] Failed ${col.name}: ${err.message}`);
        }
        await sleep(400);
      }

      // Build typePrices array from collection cards
      const typePrices = exploreCollections
        .filter(c => c.priceFrom)
        .map(c => ({ type: c.name, priceFrom: c.priceFrom, priceFromFormatted: c.priceFromFormatted }));

      // Community priceFrom = min across all collection prices
      const allPrices = typePrices.map(t => t.priceFrom).filter(Boolean);
      const communityPriceFrom = allPrices.length ? Math.min(...allPrices) : priceFrom;

      // Feature sheets: unique PDFs found on collection pages
      const featureSheets = [...allFeatureSheetUrls].map(url => ({
        name: featureSheetName(comm.name, url),
        url,
      }));

      builds.push({
        id,
        name: comm.name,
        builder: 'Caivan',
        community: neighborhood,
        address: address || `${comm.name}, ${neighborhood}, Ottawa, ON`,
        lat: coords.lat,
        lng: coords.lng,
        homeTypes,
        type: mapType,
        models: allModels,
        typePrices,
        priceFrom: communityPriceFrom,
        priceFromFormatted: formatPrice(communityPriceFrom),
        featureSheets,
        includedFeatures: allIncludedFeatures,
        status: 'selling',
        completionYear: null,
        description: description || `A Caivan community in ${neighborhood}, Ottawa.`,
        sourceUrl: comm.href,
        sourceName: 'caivan.com',
        imageUrl: '',
        scrapedAt: new Date().toISOString(),
      });

      console.log(`  [caivan] ${comm.name}: ${allModels.length} models, ${typePrices.length} price tiers, ${featureSheets.length} feature PDFs`);
      await sleep(600);
    }
  } finally {
    await browser.close();
  }

  console.log(`[caivan] Done — ${builds.length} communities`);
  return builds;
}
