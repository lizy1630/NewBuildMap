/**
 * Scraper for Richcraft Homes — richcraft.com
 * Scrapes TrailsEdge community: home types, from prices, all models with details.
 * Downloads model thumbnail images locally.
 */
import * as cheerio from 'cheerio';
import axios from 'axios';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { fetchHTML, normalizePrice, formatPrice, slugify, sleep } from '../utils.js';
import { geocode } from '../geocode.js';

const BASE_URL = 'https://www.richcraft.com';

// TrailsEdge-specific URLs
const TRAILSEDGE_URL = `${BASE_URL}/community/ottawa-east/trailsedge/`;
const TRAILSEDGE_HOMES_URL = `${BASE_URL}/community/ottawa-east/trailsedge/homes/`;

// Local image directory (relative to project root)
const IMAGES_DIR_URL = new URL('../../public/images/richcraft', import.meta.url).pathname;

// Map Richcraft type strings to canonical homeTypes
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

// Determine generic type bucket for map colouring
function toMapType(homeTypes) {
  if (!homeTypes || !homeTypes.length) return 'unknown';
  const hasDetached = homeTypes.some(t => ['Single Family', 'Bungalows'].includes(t));
  const hasTown = homeTypes.some(t => ['Townhomes', 'Thrive Towns', 'Urban Towns', 'Bungalow Towns', 'Tandem'].includes(t));
  if (hasDetached && hasTown) return 'mixed';
  if (hasDetached) return 'single-family';
  if (hasTown) return 'townhouse';
  return 'mixed';
}

/**
 * Download an image URL to a local file. Returns the local path relative to public/.
 * Skips download if file already exists.
 */
async function downloadImage(remoteUrl, filename) {
  mkdirSync(IMAGES_DIR_URL, { recursive: true });
  const dest = `${IMAGES_DIR_URL}/${filename}`;
  const publicPath = `/images/richcraft/${filename}`;

  if (existsSync(dest)) {
    return publicPath;
  }

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
    return remoteUrl; // fallback to remote URL
  }
}

/**
 * Parse the community banner page to extract home types and their from-prices.
 * Returns: { homeTypes: string[], typePrices: { [type]: number }, communityName, completionYear }
 */
async function scrapeCommunitySummary() {
  const html = await fetchHTML(TRAILSEDGE_URL);
  const $ = cheerio.load(html);

  const typePrices = {};
  const homeTypes = [];

  // home-banner-slide-content-inner contains h2 (type name) + p (From $xxx)
  $('.home-banner-slide-content-inner').each((_, el) => {
    const $el = $(el);
    $el.find('h2').each((_, h2) => {
      const typeName = $(h2).text().trim()
        .replace(/\s*Homes?$/, '') // "Single Family Homes" → "Single Family"
        .trim();
      const canonical = Object.keys(TYPE_CANONICAL).find(
        k => typeName.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(typeName.toLowerCase())
      ) || typeName;

      const priceText = $(h2).next('p').text().trim();
      const price = normalizePrice(priceText);

      if (canonical && !homeTypes.includes(canonical)) {
        homeTypes.push(canonical);
      }
      if (canonical && price) {
        typePrices[canonical] = price;
      }
    });
  });

  // Determine overall lowest from price
  const prices = Object.values(typePrices).filter(Boolean);
  const priceFrom = prices.length ? Math.min(...prices) : null;

  console.log(`  [richcraft] Community home types: ${homeTypes.join(', ')}`);
  console.log(`  [richcraft] Type prices: ${JSON.stringify(typePrices)}`);

  return { homeTypes, typePrices, priceFrom };
}

/**
 * Parse the homes listing page to extract all model cards.
 * Returns array of model objects.
 */
async function scrapeModels(typePrices) {
  const html = await fetchHTML(TRAILSEDGE_HOMES_URL);
  const $ = cheerio.load(html);
  const models = [];

  // Each model is in a .home-card > .home-listing div with data attributes
  $('.home-card').each((_, card) => {
    const $listing = $(card).find('.home-listing');
    if (!$listing.length) return;

    const name = $listing.find('h3').first().text().trim();
    if (!name) return;

    const homeType = $listing.attr('data-home-type') || '';
    const sqft = parseInt($listing.attr('data-sqft-min') || '0', 10) || null;
    const beds = parseFloat($listing.attr('data-bedrooms') || '0') || null;
    const baths = parseFloat($listing.attr('data-bathrooms') || '0') || null;
    const lotWidth = parseInt($listing.attr('data-lot-size') || '0', 10) || null;
    const garages = parseInt($listing.attr('data-garages') || '0', 10) || null;
    const hasPhotos = $listing.attr('data-photos') === 'true';

    const modelHref = $listing.find('a.abs-link').attr('href') || $listing.find('a').first().attr('href') || '';
    const modelUrl = modelHref.startsWith('http') ? modelHref : (modelHref ? BASE_URL + modelHref : '');

    // Extract background image URL from style attribute
    const imgStyle = $listing.find('.home-listing-img').attr('style') || '';
    const imgMatch = imgStyle.match(/url\(([^)]+)\)/);
    const remoteImageUrl = imgMatch ? imgMatch[1].replace(/['"]/g, '') : '';

    // Use type price as priceFrom if no model-level price
    const canonical = TYPE_CANONICAL[homeType] || homeType;
    const priceFrom = typePrices[canonical] || typePrices[homeType] || null;

    models.push({
      name,
      type: canonical || homeType,
      sqft,
      beds,
      baths,
      lotWidth,
      garages,
      priceFrom,
      modelUrl,
      remoteImageUrl,
      localImageUrl: null, // filled in after download
    });
  });

  console.log(`  [richcraft] Parsed ${models.length} models`);
  return models;
}

export async function scrape() {
  console.log('[richcraft] Starting TrailsEdge scrape...');

  let communityData;
  try {
    communityData = await scrapeCommunitySummary();
  } catch (err) {
    console.error(`[richcraft] Failed community page: ${err.message}`);
    return [];
  }

  await sleep(500);

  let models;
  try {
    models = await scrapeModels(communityData.typePrices);
  } catch (err) {
    console.error(`[richcraft] Failed homes page: ${err.message}`);
    return [];
  }

  // Download model thumbnail images
  console.log(`  [richcraft] Downloading ${models.length} model images...`);
  for (const model of models) {
    if (!model.remoteImageUrl) continue;
    // Derive filename from URL
    const urlParts = model.remoteImageUrl.split('/');
    const filename = `${slugify(model.name)}-${urlParts[urlParts.length - 1].split('?')[0]}`;
    model.localImageUrl = await downloadImage(model.remoteImageUrl, filename);
    await sleep(100); // polite delay
  }

  // Geocode TrailsEdge (Orleans/Avalon area, east Ottawa)
  const address = 'TrailsEdge, Brian Coburn Blvd, Orleans, Ottawa, ON';
  let coords = await geocode(address);
  // Fallback hardcoded coords if geocode fails (known location)
  if (!coords.lat) {
    coords = { lat: 45.4727, lng: -75.5115 };
    console.log('  [richcraft] Using hardcoded TrailsEdge coordinates');
  }

  // Build serializable models (drop remoteImageUrl from final output)
  const serialModels = models.map(({ remoteImageUrl, ...m }) => m);

  // Collect unique homeTypes from models (for communities where banner has more)
  const modelTypes = [...new Set(models.map(m => m.type).filter(Boolean))];
  const homeTypes = communityData.homeTypes.length ? communityData.homeTypes : modelTypes;

  const build = {
    id: 'richcraft-trailsedge',
    name: "TrailsEdge",
    builder: 'Richcraft Homes',
    community: 'Orléans',
    address: '5397 Renaud Rd, Orleans, Ottawa, ON',
    lat: coords.lat,
    lng: coords.lng,
    homeTypes,
    type: toMapType(homeTypes),
    models: serialModels,
    priceFrom: communityData.priceFrom,
    priceFromFormatted: formatPrice(communityData.priceFrom),
    status: 'selling',
    completionYear: null,
    description: 'A master-planned community in Orléans offering a diverse range of home types from urban towns to large single-family homes, built by Richcraft Homes.',
    sourceUrl: TRAILSEDGE_URL,
    sourceName: 'richcraft.com',
    imageUrl: '',
    scrapedAt: new Date().toISOString(),
  };

  console.log(`[richcraft] Done — 1 community, ${serialModels.length} models`);
  return [build];
}
