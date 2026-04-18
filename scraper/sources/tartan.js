/**
 * Scraper for Tartan Homes Ottawa — tartanhomes.com
 *
 * Communities scraped (by WP community ID):
 *   Idylea            → Stittsville  (ID: 20234)
 *   Findlay Creek Village → Findlay Creek (ID: 133)
 *
 * Strategy:
 *   1. Fetch /new-homes/ once — all models in HTML, filtered client-side via CSS classes
 *   2. Filter cards by community-20234 / community-133 class
 *   3. Visit each detail page to get per-community "Starting at" price
 *      (prices are in Bootstrap tab panes, one per community)
 *   4. Level 3 category = home type from URL segment (Singles, Townhomes, Bungalows, etc.)
 *   5. priceFrom = lowest non-zero price per community
 *   6. Save price report with model name, type, price, date
 *
 * GPS coords from var thcm in community pages:
 *   Idylea:               45.255877, -75.903714  (807 Poetry Cir, Stittsville)
 *   Findlay Creek Village: 45.325312, -75.608043 (3913 Kelly Farm Drive, Ottawa)
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { slugify, sleep } from '../utils.js';

const BASE_URL    = 'https://tartanhomes.com';
const LISTING_URL = 'https://tartanhomes.com/new-homes/';
const REPORTS_DIR = new URL('../../public/data/tartan-price-reports', import.meta.url).pathname;
const IMAGES_DIR  = new URL('../../public/images/tartan', import.meta.url).pathname;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

// Community config
const COMMUNITIES = {
  '20234': {
    id:        'tartan-idylea',
    name:      'Idylea',
    community: 'Stittsville',
    address:   '807 Poetry Circle, Stittsville, Ottawa, ON K2S 3E3',
    lat:       45.255877,
    lng:       -75.903714,
    tabId:     'nav-idylea',
    sourceUrl: 'https://tartanhomes.com/communities/idylea/',
  },
  '133': {
    id:        'tartan-findlay-creek-village',
    name:      'Findlay Creek Village',
    community: 'Findlay Creek',
    address:   '3913 Kelly Farm Drive, Ottawa, ON K1X 0G5',
    lat:       45.325312,
    lng:       -75.608043,
    tabId:     'nav-findlay_creek_village',
    sourceUrl: 'https://tartanhomes.com/communities/findlay-creek/',
  },
};

// Level 3 type from URL segment
const TYPE_FROM_SLUG = {
  'singles':         'Single Family',
  'bungalows':       'Bungalows',
  'semi-detached':   'Semi-Detached',
  'townhomes':       'Townhomes',
  'early-occupancy': 'Early Occupancy',
};

// Level 1 from type label
const TYPE_L1 = {
  'Single Family':   'Single Family',
  'Bungalows':       'Single Family',
  'Semi-Detached':   'Townhomes',
  'Townhomes':       'Townhomes',
  'Early Occupancy': 'Single Family',
};

function fmtPrice(n) {
  if (!n) return null;
  return '$' + Number(n).toLocaleString('en-CA');
}

function parsePrice(s) {
  if (!s) return null;
  const n = parseInt(String(s).replace(/[^0-9]/g, ''));
  return isNaN(n) || n < 100000 ? null : n;
}

function parseSqft(s) {
  if (!s) return null;
  const m = String(s).match(/[\d,]+/);
  return m ? parseInt(m[0].replace(/,/g, '')) || null : null;
}

function parseBeds(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+)/);
  return m ? parseInt(m[1]) : null;
}

function parseBaths(s) {
  if (!s) return null;
  const m = String(s).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
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

// Fetch detail page → return { prices: { communityTabId: price }, sqft, beds, baths, lotWidth }
async function fetchDetail(url) {
  try {
    const html = await get(url);
    const $    = cheerio.load(html);

    // Per-community prices from tab panes
    const prices = {};
    $('.tab-content .tab-pane').each((_, el) => {
      const id    = $(el).attr('id') || '';
      const price = parsePrice($(el).find('.home__pricing-price').first().text());
      if (id && price) prices[id] = price;
    });

    // Stats from home__stats
    let sqft = null, beds = null, baths = null, lotWidth = null;
    $('ul.home__stats li').each((_, el) => {
      const val  = $(el).find('.highlighted').text().trim();
      const text = $(el).text().toLowerCase();
      if (text.includes('square')) sqft     = parseSqft(val);
      else if (text.includes('bedroom'))  beds     = parseBeds(val);
      else if (text.includes('bathroom')) baths    = parseBaths(val);
      else if (text.includes('lot'))      lotWidth = parseInt(val) || null;
    });

    // Image — first elevation image
    const imgSrc = $('.home__elevation .elevationImage img').first().attr('src')
      || $('img.wp-post-image').first().attr('src')
      || null;

    return { prices, sqft, beds, baths, lotWidth, imgSrc };
  } catch (e) {
    console.warn(`    [tartan] detail fetch failed: ${url} — ${e.message}`);
    return { prices: {}, sqft: null, beds: null, baths: null, lotWidth: null, imgSrc: null };
  }
}

export async function scrape() {
  mkdirSync(REPORTS_DIR, { recursive: true });
  mkdirSync(IMAGES_DIR,  { recursive: true });

  console.log('[tartan] Fetching listing page…');
  const html = await get(LISTING_URL);
  const $    = cheerio.load(html);

  // Collect all models that belong to our two communities
  const modelsByComm = { '20234': [], '133': [] };

  $('div.homeItem').each((_, el) => {
    const $el    = $(el);
    const classes = $el.attr('class') || '';

    // Which of our communities does this model belong to?
    const commIds = Object.keys(COMMUNITIES).filter(id => classes.includes(`community-${id}`));
    if (!commIds.length) return;

    // Model name + detail URL
    const $nameEl   = $el.find('.home-block__card-body-block a.home-block--title');
    const name      = $nameEl.text().trim();
    const detailUrl = $nameEl.attr('href') || '';
    if (!name || !detailUrl) return;

    // Type from URL segment: /our-homes/[type-slug]/[model-slug]/
    const typeMatch = detailUrl.match(/\/our-homes\/([^/]+)\//);
    const typeSlug  = typeMatch ? typeMatch[1] : 'singles';
    const type      = TYPE_FROM_SLUG[typeSlug] || 'Single Family';

    // Sqft / beds / baths from listing card
    let sqft = null, beds = null, baths = null;
    $el.find('.home-block__card-body-block .home-block__spec').each((_, spec) => {
      const txt = $(spec).text().trim();
      if (txt.includes('sq. ft.')) sqft = parseSqft(txt);
      else if (txt.includes('Bed'))  beds = parseBeds(txt);
      else if (txt.includes('Bath')) baths = parseBaths(txt);
    });

    // Image
    const imgSrc = $el.find('.home-block__card-body-block .home-block__card-img img').attr('src') || null;

    const model = { name, detailUrl, type, typeSlug, sqft, beds, baths, imgSrc };
    commIds.forEach(id => modelsByComm[id].push(model));
  });

  console.log(`[tartan] Found: Idylea=${modelsByComm['20234'].length} models, Findlay Creek=${modelsByComm['133'].length} models`);

  // Fetch detail pages — deduplicate by URL across both communities
  const allUrls = [...new Set([
    ...modelsByComm['20234'].map(m => m.detailUrl),
    ...modelsByComm['133'].map(m => m.detailUrl),
  ])];

  const detailCache = {};
  for (const url of allUrls) {
    console.log(`  [tartan] fetching detail: ${url.split('/').slice(-2, -1)[0]}`);
    detailCache[url] = await fetchDetail(url);
    await sleep(400);
  }

  const now   = new Date().toISOString();
  const date  = now.slice(0, 10);
  const builds = [];

  for (const [commId, commCfg] of Object.entries(COMMUNITIES)) {
    const rawModels = modelsByComm[commId];
    if (!rawModels.length) {
      console.log(`[tartan] No models found for ${commCfg.name}`);
      continue;
    }

    // Enrich models with detail data
    const models = [];
    for (const m of rawModels) {
      const detail = detailCache[m.detailUrl] || {};
      const price  = detail.prices?.[commCfg.tabId] || null;
      const sqft   = detail.sqft || m.sqft;
      const beds   = detail.beds || m.beds;
      const baths  = detail.baths || m.baths;
      const lotWidth = detail.lotWidth || null;

      // Download image
      let localImageUrl = null;
      const imgUrl = detail.imgSrc || m.imgSrc;
      if (imgUrl) {
        const fullUrl = imgUrl.startsWith('http') ? imgUrl : `${BASE_URL}${imgUrl}`;
        const ext     = fullUrl.split('?')[0].split('.').pop() || 'jpg';
        const fname   = `${slugify(commCfg.name)}-${slugify(m.name)}.${ext}`;
        const dest    = `${IMAGES_DIR}/${fname}`;
        await downloadImage(fullUrl, dest);
        localImageUrl = `/images/tartan/${fname}`;
      }

      models.push({
        name:               m.name,
        type:               m.type,
        l1Category:         TYPE_L1[m.type] || 'Single Family',
        beds,
        baths,
        sqft,
        lotWidth,
        priceFrom:          price,
        priceFromFormatted: fmtPrice(price),
        status:             m.typeSlug === 'early-occupancy' ? 'Move-In Ready' : 'New Construction',
        localImageUrl,
        modelUrl:           m.detailUrl,
      });
    }

    // priceFrom = lowest non-zero price across all models
    const validPrices  = models.map(m => m.priceFrom).filter(Boolean);
    const priceFrom    = validPrices.length ? Math.min(...validPrices) : null;
    const homeTypes    = [...new Set(models.map(m => m.type))];
    const l1Types      = [...new Set(models.map(m => m.l1Category))];
    const communityType = l1Types.length === 1
      ? (l1Types[0] === 'Townhomes' ? 'townhouse' : 'single-family')
      : 'mixed';

    console.log(`[tartan] ${commCfg.name}: ${models.length} models, from ${fmtPrice(priceFrom)}`);

    // Price report
    writeFileSync(
      `${REPORTS_DIR}/${slugify(commCfg.name)}-${date}.json`,
      JSON.stringify({
        community: commCfg.name,
        builder:   'Tartan Homes',
        date:      now,
        models: models.map(m => ({
          name:     m.name,
          type:     m.type,
          beds:     m.beds,
          baths:    m.baths,
          sqft:     m.sqft,
          lotWidth: m.lotWidth,
          price:    m.priceFromFormatted,
          status:   m.status,
        })),
      }, null, 2)
    );

    builds.push({
      id:                 commCfg.id,
      name:               commCfg.name,
      builder:            'Tartan Homes',
      community:          commCfg.community,
      address:            commCfg.address,
      lat:                commCfg.lat,
      lng:                commCfg.lng,
      homeTypes,
      type:               communityType,
      models,
      typePrices:         [],
      priceFrom,
      priceFromFormatted: fmtPrice(priceFrom),
      taxIncluded:        false,
      featureSheets:      [],
      includedFeatures:   [],
      status:             'selling',
      completionYear:     null,
      description:        `${commCfg.name} by Tartan Homes in ${commCfg.community}, Ottawa.`,
      sourceUrl:          commCfg.sourceUrl,
      sourceName:         'tartanhomes.com',
      scrapedAt:          now,
    });
  }

  return builds;
}
