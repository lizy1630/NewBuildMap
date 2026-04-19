/**
 * Scraper for Glenview Homes Ottawa — glenviewhomes.com
 *
 * Communities:
 *   Ironwood       → Riverside South  (floorplans page)
 *   The Commons    → Orléans          (floorplans page)
 *   Union West     → Stittsville      (floorplans page)
 *   Wateridge Village → Ottawa East   (coming soon — no floor plans)
 *
 * Category hierarchy:
 *   Level 1: Single Family | Townhomes
 *   Level 3 (builder-specific): "34' Lot Collection", "38' Lot Collection",
 *            "Back-to-Back Townhome Collection", "Executive Townhome Collection", etc.
 *
 * Pages are server-rendered WordPress HTML — cheerio only, no headless browser.
 * GPS coords are in data-lat/data-lng on div.mapMarker.mapMarker--community.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
// Write report JSON only once per day — skip if today's file already exists
function writeReportOnce(path, data) {
  if (existsSync(path)) { console.log(`  [skip] already have ${path.split('/').pop()}`); return; }
  writeFileSync(path, JSON.stringify(data, null, 2));
}

import { slugify, sleep } from '../utils.js';

const REPORTS_DIR = new URL('../../public/data/glenview-price-reports', import.meta.url).pathname;
const IMAGES_DIR  = new URL('../../public/images/glenview', import.meta.url).pathname;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

// ── Category → Level 1 map ───────────────────────────────────────────────────
function categoryToL1(categoryKey) {
  if (categoryKey.includes('townhome')) return 'Townhomes';
  return 'Single Family';
}

function categoryLabel(categoryKey) {
  // Convert "category-34-lot-collection" → "34' Lot Collection"
  // Convert "category-back-to-back-townhome-collection" → "Back-to-Back Townhomes"
  return categoryKey
    .replace('category-', '')
    .replace(/-/g, ' ')
    .replace(/\b(\d+)\b/g, "$1'")   // 34 → 34'
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace("' Lot", "' Lot")       // already handled
    .replace('Townhome Collection', 'Townhomes')
    .replace('Lot Collection', 'Lot Collection');
}

function fmtPrice(n) {
  if (!n) return null;
  return '$' + Number(n).toLocaleString('en-CA');
}

function parsePrice(s) {
  if (!s) return null;
  const str = String(s);
  if (/coming soon|sold out/i.test(str)) return null;
  // Range: "$649,990 - $669,990" → take the lower
  const nums = str.match(/\d[\d,]*/g);
  if (!nums || !nums.length) return null;
  const val = parseInt(nums[0].replace(/,/g, ''));
  return isNaN(val) || val < 100000 ? null : val;
}

function parseSqft(s) {
  if (!s) return null;
  const m = String(s).match(/[\d,]+/);
  if (!m) return null;
  return parseInt(m[0].replace(/,/g, '')) || null;
}

function parseBeds(s) {
  if (!s) return null;
  // "4+2" → 4, "3" → 3, "2 + Flex" → 2
  const m = String(s).match(/^(\d+)/);
  return m ? parseInt(m[1]) : null;
}

function parseLotWidth(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+)'/);
  return m ? parseInt(m[1]) : null;
}

async function get(url) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
    timeout: 30000,
  });
  return res.data;
}

async function downloadImage(url, dest) {
  if (!url || existsSync(dest)) return;
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': UA },
    });
    writeFileSync(dest, res.data);
  } catch { /* skip */ }
}

// ── Scrape a floorplans page ─────────────────────────────────────────────────
async function scrapeFloorplans(communitySlug, floorplansUrl) {
  console.log(`  Glenview: fetching ${communitySlug} floor plans…`);
  const html = await get(floorplansUrl);
  const $    = cheerio.load(html);

  // Build category map: CSS class → display label
  const categoryMap = {};
  $('ul.teasersCategories__list li a').each((_, el) => {
    const filter = $(el).attr('data-filter') || '';
    const label  = $(el).text().trim();
    if (filter && filter !== '.category-all') {
      const key = filter.replace('.', '');
      categoryMap[key] = label;
    }
  });

  // GPS from map marker
  let lat = null, lng = null;
  const marker = $('div.mapMarker.mapMarker--community').first();
  if (marker.length) {
    lat = parseFloat(marker.attr('data-lat')) || null;
    lng = parseFloat(marker.attr('data-lng')) || null;
  }

  const models = [];

  $('div.homeTeaser.homeTeaser--floorplan').each((_, el) => {
    const $el = $(el);

    // Determine category (first non-"category-all" class)
    const classes    = ($el.attr('class') || '').split(/\s+/);
    const catClass   = classes.find(c => c.startsWith('category-') && c !== 'category-all') || '';
    const catLabel   = categoryMap[catClass] || categoryLabel(catClass);
    const l1         = categoryToL1(catClass);

    const name       = $el.find('.homeTeaser__name').text().trim();
    const sqftText   = $el.find('.homeTeaser__metaItem--sq').text().trim();
    const bedsText   = $el.find('.homeTeaser__metaItem--bedrooms').text().trim();
    const bathsText  = $el.find('.homeTeaser__metaItem--bathrooms').text().trim();
    const lotText    = $el.find('.homeTeaser__category').text().trim();
    const priceText  = $el.find('.homeTeaser__footer .homeTeaser__price').text().trim();
    const promoBanner = $el.find('.homeTeaser__promoBanner').text().trim();

    const price    = parsePrice(priceText);
    const sqft     = parseSqft(sqftText);
    const beds     = parseBeds(bedsText);
    const baths    = parseFloat(bathsText) || null;
    const lotWidth = parseLotWidth(lotText);

    const imgSrc = $el.find('.homeTeaser__imageContainer .homeTeaser__image').attr('src') || null;
    const detailUrl = $el.find('a.homeTeaser__anchorOverlay').attr('href') || null;

    const isSoldOut  = /sold out/i.test(priceText);
    const isQuickMove = /move.in ready|quick move/i.test(promoBanner);

    if (!name) return;

    models.push({
      name,
      categoryKey:  catClass,
      type:         catLabel,
      l1Category:   l1,
      beds,
      baths,
      sqft,
      lotWidth,
      priceFrom:          price,
      priceFromFormatted: fmtPrice(price),
      status: isSoldOut ? 'Sold Out' : isQuickMove ? 'Move-In Ready' : 'New Construction',
      imgSrc,
      localImageUrl: null,
      modelUrl:      detailUrl,
    });
  });

  // Download images
  for (const m of models) {
    if (m.imgSrc) {
      const ext   = m.imgSrc.split('?')[0].split('.').pop() || 'jpg';
      const fname = `${communitySlug}-${slugify(m.name)}.${ext}`;
      const dest  = `${IMAGES_DIR}/${fname}`;
      await downloadImage(m.imgSrc, dest);
      m.localImageUrl = `/images/glenview/${fname}`;
      await sleep(150);
    }
  }

  return { models, lat, lng };
}

// ── Build community object ────────────────────────────────────────────────────
function buildCommunity(id, name, community, address, lat, lng, models, sourceUrl, status = 'selling') {
  const validPrices = models.map(m => m.priceFrom).filter(Boolean);
  const priceFrom   = validPrices.length ? Math.min(...validPrices) : null;
  const homeTypes   = [...new Set(models.map(m => m.type))];
  const l1Types     = [...new Set(models.map(m => m.l1Category))];

  const type = l1Types.length === 1
    ? (l1Types[0] === 'Townhomes' ? 'townhouse' : 'single-family')
    : 'mixed';

  const now = new Date().toISOString();

  return {
    id,
    name,
    builder:            'Glenview Homes',
    community,
    address,
    lat,
    lng,
    homeTypes,
    type,
    models: models.map(m => ({
      name:               m.name,
      type:               m.type,
      l1Category:         m.l1Category,
      beds:               m.beds,
      baths:              m.baths,
      sqft:               m.sqft,
      lotWidth:           m.lotWidth,
      priceFrom:          m.priceFrom,
      priceFromFormatted: m.priceFromFormatted,
      status:             m.status,
      localImageUrl:      m.localImageUrl,
      modelUrl:           m.modelUrl,
    })),
    typePrices:         [],
    priceFrom,
    priceFromFormatted: fmtPrice(priceFrom),
    taxIncluded:        false,
    featureSheets:      [],
    includedFeatures:   [],
    status,
    completionYear:     null,
    description:        `${name} by Glenview Homes in ${community}, Ottawa.`,
    sourceUrl,
    sourceName:         'glenviewhomes.com',
    scrapedAt:          now,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function scrape() {
  mkdirSync(REPORTS_DIR, { recursive: true });
  mkdirSync(IMAGES_DIR,  { recursive: true });

  const builds = [];
  const now    = new Date().toISOString();
  const date   = now.slice(0, 10);

  const communities = [
    {
      id:        'glenview-ironwood',
      name:      'Ironwood',
      community: 'Riverside South',
      address:   '723 Kenny Gordon Ave, Riverside South, Ottawa, ON K4M 0X8',
      fallbackLat: 45.2536, fallbackLng: -75.6909,
      url:       'https://www.glenviewhomes.com/communities/ironwood/floorplans/',
      sourceUrl: 'https://www.glenviewhomes.com/communities/ironwood/',
    },
    {
      id:        'glenview-the-commons',
      name:      'The Commons',
      community: 'Orléans',
      address:   '174 Lumen Place, Orléans, Ottawa, ON K1W 1T1',
      fallbackLat: 45.4491, fallbackLng: -75.5202,
      url:       'https://www.glenviewhomes.com/communities/thecommons/floorplans/',
      sourceUrl: 'https://www.glenviewhomes.com/communities/thecommons/',
    },
    {
      id:        'glenview-union-west',
      name:      'Union West',
      community: 'Stittsville',
      address:   '6147 Fernbank Road, Stittsville, Ottawa, ON K2S 1K4',
      fallbackLat: 45.2623, fallbackLng: -75.8910,
      url:       'https://www.glenviewhomes.com/communities/union-west/floorplans/',
      sourceUrl: 'https://www.glenviewhomes.com/communities/union-west/',
    },
  ];

  for (const comm of communities) {
    console.log(`\nGlenview: ${comm.name} (${comm.community})…`);
    try {
      const { models, lat, lng } = await scrapeFloorplans(slugify(comm.name), comm.url);

      const useLat = lat || comm.fallbackLat;
      const useLng = lng || comm.fallbackLng;

      const validPrices = models.map(m => m.priceFrom).filter(Boolean);
      const fromPrice   = validPrices.length ? Math.min(...validPrices) : null;
      console.log(`  → ${models.length} models, from ${fmtPrice(fromPrice)}, coords: ${useLat}, ${useLng}`);

      // Price report
      writeReportOnce(`${REPORTS_DIR}/${slugify(comm.name)}-${date}.json`,
        JSON.stringify({
          community: comm.name, builder: 'Glenview Homes', date: now,
          models: models.map(m => ({
            name: m.name, type: m.type, lotWidth: m.lotWidth,
            beds: m.beds, baths: m.baths, sqft: m.sqft,
            price: m.priceFromFormatted, status: m.status,
          })),
        }, null, 2)
      );

      builds.push(buildCommunity(
        comm.id, comm.name, comm.community,
        comm.address, useLat, useLng,
        models, comm.sourceUrl
      ));
    } catch (e) {
      console.error(`  Glenview ${comm.name} failed: ${e.message}`);
    }
    await sleep(800);
  }

  // ── Wateridge Village — coming soon, no floor plans ──────────────────────
  console.log('\nGlenview: Wateridge Village (coming soon)…');
  builds.push(buildCommunity(
    'glenview-wateridge-village', 'Wateridge Village', 'Ottawa East',
    'Codd\'s Road, Ottawa, ON K1K',
    45.4530, -75.6448,
    [], // no models yet
    'https://www.glenviewhomes.com/communities/wateridge-village/',
    'coming-soon'
  ));
  console.log('  → Coming soon, no floor plans yet');

  return builds;
}
