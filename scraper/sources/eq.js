/**
 * Scraper for EQ Homes + Greystone Village Ottawa
 *
 * Communities:
 *   EQ Homes:
 *     Tapestry     → Kemptville  (eqhomes.ca/communities/tapestry)
 *     Provence     → Orléans     (eqhomes.ca/communities/provence)
 *     Pathways     → Findlay Creek (eqhomes.ca/communities/pathways)
 *   Greystone Village (EQ Homes):
 *     Forecourt    → Ottawa Urban (greystonevillage.ca/forecourt/homes.html)
 *     The Spencer  → Ottawa Urban (greystonevillage.ca/thespencer/suites.html)
 *
 * Category hierarchy:
 *   Level 1: Condo | Townhomes | Single Family
 *   Level 2: manual (user-defined)
 *   Level 3: builder-specific type label (bungalow-singles, modern-townhomes, etc.)
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { slugify, sleep } from '../utils.js';
import { geocode } from '../geocode.js';

const REPORTS_DIR = new URL('../../public/data/eq-price-reports', import.meta.url).pathname;
const IMAGES_DIR  = new URL('../../public/images/eq', import.meta.url).pathname;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

// ── Level 3 → Level 1 category map ─────────────────────────────────────────
const HOME_TYPE_L1 = {
  'bungalow-singles':          'Single Family',
  'two-storey-singles':        'Single Family',
  'multi-gen-homes':           'Single Family',
  'modern-townhomes':          'Townhomes',
  'back-to-back-townhomes':    'Townhomes',
  'Forecourt Townhome':        'Townhomes',
  'One Bedroom':               'Condo',
  'One Bedroom + Den':         'Condo',
  'Two Bedroom':               'Condo',
  'Two Bedroom + Den':         'Condo',
};

// Level 3 display labels (from key)
const HOME_TYPE_LABEL = {
  'bungalow-singles':          'Bungalows',
  'two-storey-singles':        'Single Family',
  'multi-gen-homes':           'Multi-Gen',
  'modern-townhomes':          'Townhomes',
  'back-to-back-townhomes':    'Townhomes',
  'Forecourt Townhome':        'Townhomes',
  'One Bedroom':               'One Bedroom',
  'One Bedroom + Den':         'One Bedroom + Den',
  'Two Bedroom':               'Two Bedroom',
  'Two Bedroom + Den':         'Two Bedroom + Den',
};

function fmtPrice(n) {
  if (!n) return null;
  return '$' + Number(n).toLocaleString('en-CA');
}

function parsePrice(s) {
  if (!s) return null;
  const n = parseInt(String(s).replace(/[^0-9]/g, ''));
  return isNaN(n) || n === 0 ? null : n;
}

function parseSqft(s) {
  if (!s) return null;
  // Take only the first number (handles "2,569 - 2,760 sq. ft." multi-gen ranges)
  const match = String(s).match(/[\d,]+/);
  if (!match) return null;
  const n = parseInt(match[0].replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function parseBaths(s) {
  if (!s) return null;
  // Handle "2-5" → 2.5, "2" → 2
  const clean = String(s).replace('bath-', '').trim();
  if (clean.includes('-')) {
    const [whole, dec] = clean.split('-');
    return parseFloat(`${whole}.${dec}`);
  }
  return parseFloat(clean) || null;
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

// ── EQ Homes floor-plan page scraper ───────────────────────────────────────
async function scrapeEQFloorPlans(community, floorPlansUrl, communitySlug) {
  console.log(`  EQ: fetching floor plans for ${community}…`);
  const html = await get(floorPlansUrl);
  const $    = cheerio.load(html);
  const models = [];

  $('.filterItem').each((_, el) => {
    const $el     = $(el);
    const classes = $el.attr('class') || '';

    // Home type from class e.g. "homeType-bungalow-singles"
    const htMatch = classes.match(/homeType-([\w-]+)/);
    const homeTypeKey = htMatch ? htMatch[1] : 'unknown';

    // Beds/baths from class tokens
    const bedMatch  = classes.match(/\bbed-(\d+)/);
    const bathMatch = classes.match(/\bbath-([\d-]+)/);
    const beds  = bedMatch  ? parseInt(bedMatch[1])       : null;
    const baths = bathMatch ? parseBaths(bathMatch[1])    : null;

    // Quick move-in
    const isQuickMove = classes.includes('quickMoves-1');

    // Model name (strip hidden span)
    const nameRaw = $el.find('h2.heading2').clone()
      .find('span').remove().end().text().trim();

    // Sqft
    const sqftText = $el.find('div.ps-3.mt-3 p.fw-bo.fs-20').first().text();
    const sqft = parseSqft(sqftText);

    // Price — check for quick-move-in "now" price first, then standard
    let priceRaw = null;
    const nowPrice = $el.find('div.d-inline.fw-bo').first().text();
    if (nowPrice && nowPrice.trim()) {
      priceRaw = nowPrice.trim();
    } else {
      priceRaw = $el.find('div.ps-3.mt-3 p span.fw-bo').first().text();
    }
    const price = parsePrice(priceRaw);

    // Images from carousel (background-image style)
    const images = [];
    $el.find('.carousel-item').each((_, ci) => {
      const style = $(ci).attr('style') || '';
      const imgMatch = style.match(/url\(['"]?([^'")\s]+)['"]?\)/);
      if (imgMatch) {
        let src = imgMatch[1];
        if (src.startsWith('/')) src = `https://eqhomes.ca${src}`;
        images.push(src);
      }
    });

    // Detail URL
    const detailUrl = $el.find('a.btnMoreWbtn').attr('href') || null;

    if (!nameRaw) return; // skip empty cards

    const l1   = HOME_TYPE_L1[homeTypeKey]    || 'Single Family';
    const type = HOME_TYPE_LABEL[homeTypeKey] || homeTypeKey;

    models.push({
      name: nameRaw,
      homeTypeKey,
      type,
      l1Category: l1,
      beds,
      baths,
      sqft,
      priceFrom:           price,
      priceFromFormatted:  fmtPrice(price),
      isQuickMove,
      images,
      localImageUrl: null,
      modelUrl: detailUrl,
    });
  });

  // Download first image per model
  for (const m of models) {
    if (m.images.length) {
      const ext   = m.images[0].split('?')[0].split('.').pop() || 'jpg';
      const fname = `${communitySlug}-${slugify(m.name)}.${ext}`;
      const dest  = `${IMAGES_DIR}/${fname}`;
      await downloadImage(m.images[0], dest);
      m.localImageUrl = `/images/eq/${fname}`;
      await sleep(150);
    }
  }

  return models;
}

// ── Greystone Forecourt scraper ─────────────────────────────────────────────
async function scrapeForecourt() {
  console.log('  EQ: fetching Forecourt (Greystone)…');
  const html = await get('https://greystonevillage.ca/forecourt/homes.html');
  const $    = cheerio.load(html);
  const models = [];

  $('.property-card').each((_, el) => {
    const $el = $(el);

    const name  = $el.find('h2.property-title').text().trim();
    const price = parsePrice($el.find('h3.price').text());

    // Beds / baths / sqft from info-items
    let beds = null, baths = null, sqft = null;
    $el.find('.info-item').each((_, item) => {
      const alt  = $(item).find('img').attr('alt') || '';
      const val  = $(item).find('p').text().trim();
      if (alt.includes('Square'))  sqft  = parseSqft(val);
      else if (alt.includes('Bed')) {
        const b = parseInt(val);
        beds = isNaN(b) ? null : b;
      } else if (alt.includes('Bath')) {
        baths = parseFloat(val) || null;
      }
    });

    const imgSrc   = $el.find('img.card-img-top').attr('src') || null;
    const detailHref = $el.find('a.btn').attr('href') || null;
    const detailUrl  = detailHref
      ? (detailHref.startsWith('http') ? detailHref : `https://greystonevillage.ca${detailHref}`)
      : null;

    if (!name) return;

    models.push({
      name,
      homeTypeKey:        'Forecourt Townhome',
      type:               'Townhomes',
      l1Category:         'Townhomes',
      beds,
      baths,
      sqft,
      priceFrom:          price,
      priceFromFormatted: fmtPrice(price),
      isQuickMove:        false,
      images:             imgSrc ? [imgSrc] : [],
      localImageUrl:      null,
      modelUrl:           detailUrl,
    });
  });

  // Download images
  for (const m of models) {
    if (m.images[0]) {
      const ext   = m.images[0].split('?')[0].split('.').pop() || 'jpg';
      const fname = `forecourt-${slugify(m.name)}.${ext}`;
      const dest  = `${IMAGES_DIR}/${fname}`;
      await downloadImage(m.images[0], dest);
      m.localImageUrl = `/images/eq/${fname}`;
      await sleep(150);
    }
  }

  return models;
}

// ── Greystone The Spencer scraper ────────────────────────────────────────────
async function scrapeSpencer() {
  console.log('  EQ: fetching The Spencer (Greystone)…');
  const html = await get('https://greystonevillage.ca/thespencer/suites.html');
  const $    = cheerio.load(html);
  const models = [];

  // Scrape typed tab panes only (skip #alltab to avoid duplicates)
  const typePanes = [
    { id: '#nav-One-Bedroom---Den', label: 'One Bedroom + Den', beds: 1 },
    { id: '#nav-One-Bedroom',       label: 'One Bedroom',       beds: 1 },
    { id: '#nav-Two-Bedroom---Den', label: 'Two Bedroom + Den', beds: 2 },
    { id: '#nav-Two-Bedroom',       label: 'Two Bedroom',       beds: 2 },
  ];

  for (const pane of typePanes) {
    $(pane.id).find('.fp-block').each((_, el) => {
      const $el = $(el);

      const name     = $el.find('h3 strong').text().trim();
      const infoText = $el.find('p.fs-12').text();

      const suiteMatch   = infoText.match(/SUITE:\s*#?(\S+)/i);
      const sqftMatch    = infoText.match(/SQ\.FT\.\s*([\d,]+)/i);
      const priceMatch   = infoText.match(/PRICE:\s*\$([\d,]+)/i);

      const sqft  = sqftMatch  ? parseSqft(sqftMatch[1])          : null;
      const price = priceMatch ? parsePrice(priceMatch[1])        : null;
      const suite = suiteMatch ? suiteMatch[1]                    : null;

      const imgSrc    = $el.find('img.img-fluid').attr('src') || null;
      const detailHref = $el.find('a').attr('href') || null;
      const detailUrl  = detailHref
        ? (detailHref.startsWith('http') ? detailHref : `https://greystonevillage.ca${detailHref}`)
        : null;

      if (!name || !price) return; // skip sold/unavailable ($0 or missing)

      models.push({
        name:               `${name}${suite ? ` (#${suite})` : ''}`,
        homeTypeKey:        pane.label,
        type:               pane.label,
        l1Category:         'Condo',
        beds:               pane.beds,
        baths:              null,
        sqft,
        priceFrom:          price,
        priceFromFormatted: fmtPrice(price),
        isQuickMove:        false,
        images:             imgSrc ? [imgSrc.startsWith('http') ? imgSrc : `https://greystonevillage.ca${imgSrc}`] : [],
        localImageUrl:      null,
        modelUrl:           detailUrl,
      });
    });
  }

  // Download images (one per suite type, not per unit — too many)
  const seenTypes = new Set();
  for (const m of models) {
    const typeKey = m.homeTypeKey;
    if (!seenTypes.has(typeKey) && m.images[0]) {
      seenTypes.add(typeKey);
      const ext   = m.images[0].split('?')[0].split('.').pop() || 'jpg';
      const fname = `the-spencer-${slugify(typeKey)}.${ext}`;
      const dest  = `${IMAGES_DIR}/${fname}`;
      await downloadImage(m.images[0], dest);
      m.localImageUrl = `/images/eq/${fname}`;
      await sleep(150);
    }
  }

  return models;
}

// ── Build community object ───────────────────────────────────────────────────
function buildCommunity(id, name, builder, community, address, lat, lng, models, sourceUrl) {
  const validPrices = models.map(m => m.priceFrom).filter(Boolean);
  const priceFrom   = validPrices.length ? Math.min(...validPrices) : null;

  const homeTypes   = [...new Set(models.map(m => m.type))];
  const l1Types     = [...new Set(models.map(m => m.l1Category))];

  // type field: single L1 or 'mixed'
  const type = l1Types.length === 1
    ? (l1Types[0] === 'Condo' ? 'condo' : l1Types[0] === 'Townhomes' ? 'townhouse' : 'single-family')
    : 'mixed';

  const now = new Date().toISOString();

  return {
    id,
    name,
    builder,
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
      priceFrom:          m.priceFrom,
      priceFromFormatted: m.priceFromFormatted,
      status:             m.isQuickMove ? 'Move-In Ready' : 'New Construction',
      localImageUrl:      m.localImageUrl,
      modelUrl:           m.modelUrl,
    })),
    typePrices:         [],
    priceFrom,
    priceFromFormatted: fmtPrice(priceFrom),
    taxIncluded:        false,
    featureSheets:      [],
    includedFeatures:   [],
    status:             'selling',
    completionYear:     null,
    description:        `${name} by ${builder} in ${community}, Ottawa.`,
    sourceUrl,
    sourceName:         builder === 'EQ Homes' ? 'eqhomes.ca' : 'greystonevillage.ca',
    scrapedAt:          now,
  };
}

// ── Main export ──────────────────────────────────────────────────────────────
export async function scrape() {
  mkdirSync(REPORTS_DIR, { recursive: true });
  mkdirSync(IMAGES_DIR,  { recursive: true });

  const builds = [];
  const now    = new Date().toISOString();
  const date   = now.slice(0, 10);

  // ── EQ Homes: Tapestry ───────────────────────────────────────────────────
  console.log('\nEQ: Tapestry (Kemptville)…');
  try {
    const models = await scrapeEQFloorPlans(
      'Tapestry', 'https://eqhomes.ca/communities/tapestry/floor-plans', 'tapestry'
    );
    writeFileSync(`${REPORTS_DIR}/tapestry-${date}.json`,
      JSON.stringify({ community: 'Tapestry', builder: 'EQ Homes', date: now, models: models.map(m => ({
        name: m.name, type: m.type, beds: m.beds, baths: m.baths,
        sqft: m.sqft, price: m.priceFromFormatted, status: m.isQuickMove ? 'Move-In Ready' : 'New Construction',
      }))}, null, 2));
    console.log(`  → ${models.length} models, from ${fmtPrice(Math.min(...models.map(m=>m.priceFrom).filter(Boolean)))}`);
    builds.push(buildCommunity(
      'eq-tapestry', 'Tapestry', 'EQ Homes', 'Kemptville',
      '74 Equinelle Drive, Kemptville, ON K0G 1J0',
      45.0389, -75.6770,
      models, 'https://eqhomes.ca/communities/tapestry'
    ));
  } catch (e) { console.error(`  EQ Tapestry failed: ${e.message}`); }
  await sleep(1000);

  // ── EQ Homes: Provence ───────────────────────────────────────────────────
  console.log('\nEQ: Provence (Orléans)…');
  try {
    const models = await scrapeEQFloorPlans(
      'Provence', 'https://eqhomes.ca/communities/provence/floor-plans', 'provence'
    );
    writeFileSync(`${REPORTS_DIR}/provence-${date}.json`,
      JSON.stringify({ community: 'Provence', builder: 'EQ Homes', date: now, models: models.map(m => ({
        name: m.name, type: m.type, beds: m.beds, baths: m.baths,
        sqft: m.sqft, price: m.priceFromFormatted, status: m.isQuickMove ? 'Move-In Ready' : 'New Construction',
      }))}, null, 2));
    console.log(`  → ${models.length} models, from ${fmtPrice(Math.min(...models.map(m=>m.priceFrom).filter(Boolean)))}`);
    builds.push(buildCommunity(
      'eq-provence', 'Provence', 'EQ Homes', 'Orléans',
      '415 Ave. du Ventoux, Ottawa, ON K4A 3R4',
      45.4655, -75.4544,
      models, 'https://eqhomes.ca/communities/provence'
    ));
  } catch (e) { console.error(`  EQ Provence failed: ${e.message}`); }
  await sleep(1000);

  // ── EQ Homes: Pathways ───────────────────────────────────────────────────
  console.log('\nEQ: Pathways (Findlay Creek)…');
  try {
    const models = await scrapeEQFloorPlans(
      'Pathways', 'https://eqhomes.ca/communities/pathways/floor-plans', 'pathways'
    );
    writeFileSync(`${REPORTS_DIR}/pathways-${date}.json`,
      JSON.stringify({ community: 'Pathways', builder: 'EQ Homes', date: now, models: models.map(m => ({
        name: m.name, type: m.type, beds: m.beds, baths: m.baths,
        sqft: m.sqft, price: m.priceFromFormatted, status: m.isQuickMove ? 'Move-In Ready' : 'New Construction',
      }))}, null, 2));
    console.log(`  → ${models.length} models, from ${fmtPrice(Math.min(...models.map(m=>m.priceFrom).filter(Boolean)))}`);
    builds.push(buildCommunity(
      'eq-pathways', 'Pathways', 'EQ Homes', 'Findlay Creek',
      '122 Dun Skipper Drive, Ottawa, ON K1X 0G2',
      45.3089, -75.5922,
      models, 'https://eqhomes.ca/communities/pathways'
    ));
  } catch (e) { console.error(`  EQ Pathways failed: ${e.message}`); }
  await sleep(1000);

  // ── Greystone: Forecourt ─────────────────────────────────────────────────
  console.log('\nEQ: Forecourt / Greystone Village…');
  try {
    const models = await scrapeForecourt();
    writeFileSync(`${REPORTS_DIR}/forecourt-${date}.json`,
      JSON.stringify({ community: 'Forecourt', builder: 'EQ Homes (Greystone Village)', date: now, models: models.map(m => ({
        name: m.name, type: m.type, beds: m.beds, baths: m.baths,
        sqft: m.sqft, price: m.priceFromFormatted,
      }))}, null, 2));
    console.log(`  → ${models.length} models, from ${fmtPrice(Math.min(...models.map(m=>m.priceFrom).filter(Boolean)))}`);
    builds.push(buildCommunity(
      'eq-greystone-forecourt', 'Forecourt', 'EQ Homes', 'Ottawa',
      '1737 Woodward Drive, Ottawa, ON K2C 0P9',
      45.3742, -75.7285,
      models, 'https://greystonevillage.ca/forecourt/homes.html'
    ));
  } catch (e) { console.error(`  EQ Forecourt failed: ${e.message}`); }
  await sleep(1000);

  // ── Greystone: The Spencer ───────────────────────────────────────────────
  console.log('\nEQ: The Spencer / Greystone Village…');
  try {
    const models = await scrapeSpencer();
    writeFileSync(`${REPORTS_DIR}/the-spencer-${date}.json`,
      JSON.stringify({ community: 'The Spencer', builder: 'EQ Homes (Greystone Village)', date: now, models: models.map(m => ({
        name: m.name, type: m.type, beds: m.beds, baths: m.baths,
        sqft: m.sqft, price: m.priceFromFormatted,
      }))}, null, 2));
    console.log(`  → ${models.length} models, from ${fmtPrice(Math.min(...models.map(m=>m.priceFrom).filter(Boolean)))}`);
    builds.push(buildCommunity(
      'eq-greystone-spencer', 'The Spencer', 'EQ Homes', 'Ottawa East',
      '360 Deschâtelets Ave, Ottawa, ON K1S 5Y1',
      45.4175, -75.6712,
      models, 'https://greystonevillage.ca/thespencer/suites.html'
    ));
  } catch (e) { console.error(`  EQ The Spencer failed: ${e.message}`); }

  return builds;
}
