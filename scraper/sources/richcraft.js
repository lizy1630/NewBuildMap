/**
 * Scraper for Richcraft Homes — richcraft.com
 *
 * Discovers all communities listed under /community/ottawa-east/ and scrapes
 * each one for: home types, starting-from prices, and all model cards with
 * specs + thumbnail images.
 *
 * URL patterns:
 *   Community list : https://www.richcraft.com/community/ottawa-east/
 *   Community page : https://www.richcraft.com/community/ottawa-east/<SLUG>/
 *   Homes page     : https://www.richcraft.com/community/ottawa-east/<SLUG>/homes/
 */
import * as cheerio from 'cheerio';
import axios from 'axios';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { fetchHTML, normalizePrice, formatPrice, slugify, sleep } from '../utils.js';
import { geocode } from '../geocode.js';

const BASE_URL = 'https://www.richcraft.com';

// All Ottawa area listing pages and their neighbourhood labels
const AREA_PAGES = [
  { path: 'ottawa-east',  neighbourhood: 'Orléans' },
  { path: 'ottawa-south', neighbourhood: 'Barrhaven' },
  { path: 'ottawa-west',  neighbourhood: 'Kanata' },
];

// Fallback coords — Nominatim consistently 403s
const KNOWN_COORDS = {
  'trailsedge':     { lat: 45.4387, lng: -75.5040 },  // Orléans
  'pathways':       { lat: 45.2654, lng: -75.7769 },  // Barrhaven
  'riverside-south':{ lat: 45.2821, lng: -75.6858 },  // Riverside South
  'bradley_commons':{ lat: 45.2827, lng: -75.8962 },  // Stittsville
  'mapleton':       { lat: 45.2910, lng: -75.9073 },  // Kanata West
  'kanata-lakes':   { lat: 45.3259, lng: -75.9181 },  // Kanata Lakes
  'gateway-flats':  { lat: 45.2640, lng: -75.8920 },  // Stittsville (near Westwood)
  'westwood':       { lat: 45.2631, lng: -75.8914 },  // Stittsville
};

// Local image directory (relative to project root)
const IMAGES_DIR_URL = new URL('../../public/images/richcraft', import.meta.url).pathname;

// Map Richcraft type strings → canonical homeTypes used across the app
const TYPE_CANONICAL = {
  'Single Family': 'Single Family',
  'Bungalows': 'Bungalows',
  'Bungalow Towns': 'Bungalow Towns',
  'Townhomes': 'Townhomes',
  'Thrive Towns': 'Thrive Towns',
  'Urban Towns': 'Urban Towns',
  'Multi-Gen': 'Multi-Gen',
  'Tandem': 'Tandem',
};

// Determine generic map-type bucket from home types array
function toMapType(homeTypes) {
  if (!homeTypes || !homeTypes.length) return 'unknown';
  const hasDetached = homeTypes.some(t => ['Single Family', 'Bungalows'].includes(t));
  const hasTown = homeTypes.some(t =>
    ['Townhomes', 'Thrive Towns', 'Urban Towns', 'Bungalow Towns', 'Tandem', 'Multi-Gen'].includes(t)
  );
  if (hasDetached && hasTown) return 'mixed';
  if (hasDetached) return 'single-family';
  if (hasTown) return 'townhouse';
  return 'mixed';
}

/**
 * Download a remote image to local storage.
 * Returns the public-relative path (/images/richcraft/...) or falls back to remote URL.
 */
async function downloadImage(remoteUrl, filename) {
  mkdirSync(IMAGES_DIR_URL, { recursive: true });
  const dest = `${IMAGES_DIR_URL}/${filename}`;
  const publicPath = `/images/richcraft/${filename}`;

  if (existsSync(dest)) return publicPath;

  try {
    const response = await axios.get(remoteUrl, {
      responseType: 'stream',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    await new Promise((resolve, reject) => {
      const writer = createWriteStream(dest);
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    return publicPath;
  } catch (err) {
    console.warn(`  [richcraft] Failed to download image ${remoteUrl}: ${err.message}`);
    return remoteUrl;
  }
}

/**
 * Fetch all Ottawa area listing pages and return all community slugs + area paths.
 * Falls back to a hardcoded list if scraping yields nothing.
 */
async function fetchCommunityList() {
  console.log('[richcraft] Fetching all Ottawa community lists...');
  const seen = new Set();
  const communities = [];

  for (const area of AREA_PAGES) {
    const url = `${BASE_URL}/community/${area.path}/`;
    let html;
    try {
      html = await fetchHTML(url);
    } catch (err) {
      console.warn(`[richcraft] Could not fetch ${area.path} list: ${err.message}`);
      continue;
    }

    const $ = cheerio.load(html);
    const pattern = new RegExp(`/community/${area.path}/([a-z0-9_-]+)/`, 'i');

    $(`a[href*="/community/${area.path}/"]`).each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(pattern);
      if (!m) return;
      const slug = m[1].toLowerCase();
      const key  = `${area.path}/${slug}`;
      if (seen.has(key)) return;
      seen.add(key);
      const linkText = $(el).text().trim();
      const name = linkText.length > 2 ? linkText : slug;
      communities.push({ slug, area: area.path, neighbourhood: area.neighbourhood, name });
    });

    await sleep(400);
  }

  console.log(`[richcraft] Found ${communities.length} communities: ${communities.map(c => `${c.slug}(${c.area})`).join(', ')}`);
  return communities.length ? communities : null;
}

/**
 * Scrape the community banner page for home types and their starting-from prices.
 * Also extracts the official community name from the page heading.
 *
 * Returns: { name, homeTypes, typePrices, priceFrom, description }
 */
async function scrapeCommunitySummary(communityUrl) {
  const html = await fetchHTML(communityUrl);
  const $ = cheerio.load(html);

  // Community name — try multiple heading selectors
  const rawName =
    $('h1.community-title, .community-name, .page-title h1, h1').first().text().trim() ||
    $('title').text().split('|')[0].split('-')[0].trim() ||
    communityUrl.split('/').filter(Boolean).pop();

  const name = rawName.replace(/\s+/g, ' ').trim();

  // Description
  const description =
    $('.community-description p, .intro-text p, .community-intro p').first().text().trim() ||
    $('meta[name="description"]').attr('content') || '';

  const typePrices = {};
  const homeTypes = [];

  // Primary selector: banner slides with h2 (type name) + p (From $xxx)
  $('.home-banner-slide-content-inner').each((_, el) => {
    const $el = $(el);
    $el.find('h2').each((_, h2) => {
      const typeName = $(h2).text().trim()
        .replace(/\s*Homes?$/i, '')
        .trim();
      const canonical = Object.keys(TYPE_CANONICAL).find(
        k => typeName.toLowerCase().includes(k.toLowerCase()) ||
             k.toLowerCase().includes(typeName.toLowerCase())
      ) || typeName;

      const priceText = $(h2).next('p').text().trim();
      const price = normalizePrice(priceText);

      if (canonical && !homeTypes.includes(canonical)) homeTypes.push(canonical);
      if (canonical && price) typePrices[canonical] = price;
    });
  });

  // Fallback: look for any "From $xxx" price near home type labels
  if (!homeTypes.length) {
    $('[class*="home-type"], [class*="housing-type"]').each((_, el) => {
      const typeName = $(el).find('h2, h3, .title').first().text().trim()
        .replace(/\s*Homes?$/i, '').trim();
      if (!typeName) return;
      const canonical = TYPE_CANONICAL[typeName] || typeName;
      const priceText = $(el).find('p, .price').first().text().trim();
      const price = normalizePrice(priceText);
      if (canonical && !homeTypes.includes(canonical)) homeTypes.push(canonical);
      if (canonical && price) typePrices[canonical] = price;
    });
  }

  const prices = Object.values(typePrices).filter(Boolean);
  const priceFrom = prices.length ? Math.min(...prices) : null;

  console.log(`  [richcraft] ${name}: types=${homeTypes.join(', ')}, priceFrom=${priceFrom}`);
  return { name, homeTypes, typePrices, priceFrom, description };
}

/**
 * Scrape the /homes/ listing page for all model cards.
 * Returns array of model objects with specs and image URLs.
 */
async function scrapeModels(homesUrl, typePrices) {
  let html;
  try {
    html = await fetchHTML(homesUrl);
  } catch (err) {
    console.warn(`  [richcraft] Could not fetch homes page ${homesUrl}: ${err.message}`);
    return [];
  }

  const $ = cheerio.load(html);
  const models = [];

  // Each model card: .home-card > .home-listing with data-* attributes
  $('.home-card').each((_, card) => {
    const $listing = $(card).find('.home-listing');
    if (!$listing.length) return;

    const name = $listing.find('h3').first().text().trim();
    if (!name) return;

    const homeType = $listing.attr('data-home-type') || '';
    const sqft     = parseInt($listing.attr('data-sqft-min')   || '0', 10) || null;
    const beds     = parseFloat($listing.attr('data-bedrooms') || '0') || null;
    const baths    = parseFloat($listing.attr('data-bathrooms')|| '0') || null;
    const lotWidth = parseInt($listing.attr('data-lot-size')   || '0', 10) || null;
    const garages  = parseInt($listing.attr('data-garages')    || '0', 10) || null;

    // Model detail URL
    const modelHref = $listing.find('a.abs-link').attr('href') ||
                      $listing.find('a').first().attr('href') || '';
    const modelUrl  = modelHref.startsWith('http') ? modelHref :
                      (modelHref ? BASE_URL + modelHref : '');

    // Thumbnail from background-image style
    const imgStyle    = $listing.find('.home-listing-img').attr('style') || '';
    const imgMatch    = imgStyle.match(/url\(([^)]+)\)/);
    const remoteImageUrl = imgMatch ? imgMatch[1].replace(/['"]/g, '') : '';

    const canonical = TYPE_CANONICAL[homeType] || homeType;

    models.push({
      name,
      type: canonical || homeType,
      sqft,
      beds,
      baths,
      lotWidth,
      garages,
      // No model-level price exposed — community starting price is shown instead
      priceFrom: null,
      modelUrl,
      remoteImageUrl,
      localImageUrl: null,
    });
  });

  console.log(`  [richcraft] Parsed ${models.length} models from ${homesUrl}`);
  return models;
}

/**
 * Scrape and build one community entry.
 */
async function scrapeCommunity(slug, area = 'ottawa-east', neighbourhood = 'Orléans') {
  const communityUrl = `${BASE_URL}/community/${area}/${slug}/`;
  const homesUrl     = `${BASE_URL}/community/${area}/${slug}/homes/`;

  console.log(`[richcraft] Scraping community: ${slug}`);

  let communityData;
  try {
    communityData = await scrapeCommunitySummary(communityUrl);
  } catch (err) {
    console.error(`[richcraft] Failed community page for ${slug}: ${err.message}`);
    return null;
  }

  await sleep(400);

  const models = await scrapeModels(homesUrl, communityData.typePrices);

  await sleep(200);

  // Download model thumbnail images
  for (const model of models) {
    if (!model.remoteImageUrl) continue;
    const urlParts  = model.remoteImageUrl.split('/');
    const filename  = `${slug}-${slugify(model.name)}-${urlParts[urlParts.length - 1].split('?')[0]}`;
    model.localImageUrl = await downloadImage(model.remoteImageUrl, filename);
    await sleep(80);
  }

  // Geocode community address — fall back to hardcoded if Nominatim fails
  const geoQuery = `${communityData.name}, Ottawa, ON, Canada`;
  let coords = await geocode(geoQuery);
  if (!coords.lat) coords = await geocode(`${slug} Ottawa ON`);
  if (!coords.lat && KNOWN_COORDS[slug]) {
    coords = KNOWN_COORDS[slug];
    console.log(`  [richcraft] Using fallback coords for ${slug}`);
  }
  if (!coords.lat) {
    console.warn(`  [richcraft] Geocode failed for ${slug} — no coordinates`);
  }

  // Collect unique homeTypes (banner + models)
  const modelTypes = [...new Set(models.map(m => m.type).filter(Boolean))];
  const homeTypes  = communityData.homeTypes.length ? communityData.homeTypes : modelTypes;

  // Strip remoteImageUrl from serialized output
  const serialModels = models.map(({ remoteImageUrl, ...m }) => m);

  // Build typePrices array for consistent display with Caivan
  const typePrices = Object.entries(communityData.typePrices || {})
    .filter(([, price]) => price)
    .map(([type, price]) => ({ type, priceFrom: price, priceFromFormatted: formatPrice(price) }));

  return {
    id: `richcraft-${slug}`,
    name: communityData.name || slug,
    builder: 'Richcraft Homes',
    community: neighbourhood,
    address: `${communityData.name}, ${neighbourhood}, Ottawa, ON`,
    lat: coords.lat,
    lng: coords.lng,
    homeTypes,
    type: toMapType(homeTypes),
    models: serialModels,
    typePrices,
    priceFrom: communityData.priceFrom,
    priceFromFormatted: formatPrice(communityData.priceFrom),
    status: 'selling',
    completionYear: null,
    description: communityData.description || `A Richcraft Homes community in Orléans, Ottawa.`,
    sourceUrl: communityUrl,
    sourceName: 'richcraft.com',
    imageUrl: '',
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Main export — scrapes all Richcraft Ottawa East communities.
 */
export async function scrape() {
  console.log('[richcraft] Starting Ottawa East scrape...');

  const communities = await fetchCommunityList();

  // Fallback: if list page scraping failed, use known communities
  const list = communities || [
    { slug: 'trailsedge',     area: 'ottawa-east',  neighbourhood: 'Orléans' },
    { slug: 'riverside-south',area: 'ottawa-south', neighbourhood: 'Barrhaven' },
    { slug: 'pathways',       area: 'ottawa-south', neighbourhood: 'Barrhaven' },
  ];

  const builds = [];
  for (const c of list) {
    const build = await scrapeCommunity(c.slug, c.area, c.neighbourhood);
    if (build) builds.push(build);
    await sleep(600); // polite delay between communities
  }

  console.log(`[richcraft] Done — ${builds.length} communities scraped`);
  return builds;
}
