/**
 * Scraper for Mattamy Homes — mattamyhomes.com
 * Mattamy is Canada's largest home builder; their site is React/Next.js rendered.
 * Strategy: check __NEXT_DATA__ first, then Playwright.
 */
import * as cheerio from 'cheerio';
import { fetchHTML, normalizePrice, formatPrice, slugify, extractEmbeddedJSON, sleep } from '../utils.js';
import { geocode } from '../geocode.js';

const BASE_URL = 'https://www.mattamyhomes.com';
const LISTING_URL = 'https://www.mattamyhomes.com/communities/ontario/ottawa';

export async function scrape() {
  console.log('[mattamy] Starting scrape...');

  let html;
  try {
    html = await fetchHTML(LISTING_URL);
  } catch (err) {
    console.error(`[mattamy] Failed to fetch: ${err.message}`);
    return [];
  }

  // Try __NEXT_DATA__ first
  const embedded = extractEmbeddedJSON(html);
  if (embedded) {
    const builds = parseNextData(embedded);
    if (builds.length > 0) {
      console.log(`[mattamy] Parsed ${builds.length} builds from __NEXT_DATA__`);
      // Geocode missing coords
      for (const b of builds) {
        if (!b.lat && b.address) {
          const coords = await geocode(b.address);
          b.lat = coords.lat;
          b.lng = coords.lng;
        }
      }
      return builds;
    }
  }

  // HTML fallback
  const $ = cheerio.load(html);
  const cards = $('[class*="CommunityCard"], [class*="community-card"], [class*="CommunityTile"], .community-item').not('script, style');

  if (cards.length === 0) {
    console.warn('[mattamy] Zero cards found — trying Playwright...');
    console.warn('[mattamy] HTML snippet:', html.slice(0, 500));
    return await playwrightFallback();
  }

  const builds = [];
  console.log(`[mattamy] Found ${cards.length} community cards`);

  for (let i = 0; i < cards.length; i++) {
    const card = cards.eq(i);
    const name = card.find('h2, h3, h4, [class*="Title"], [class*="Name"]').first().text().trim();
    if (!name) continue;

    const priceText = card.find('[class*="Price"], [class*="price"]').first().text().trim();
    const typeText = card.find('[class*="Type"], [class*="type"]').first().text().trim();
    const locationText = card.find('[class*="Location"], [class*="City"], [class*="Neighbourhood"]').first().text().trim();
    const imageUrl = card.find('img').first().attr('src') || '';
    const linkHref = card.find('a').first().attr('href') || '';
    const detailUrl = linkHref.startsWith('http') ? linkHref : BASE_URL + linkHref;

    const priceFrom = normalizePrice(priceText);
    const addressGuess = locationText ? `${locationText}, Ottawa, ON` : `${name}, Ottawa, ON`;
    const coords = await geocode(addressGuess);

    builds.push({
      id: `mattamy-${slugify(name)}`,
      name,
      builder: 'Mattamy Homes',
      community: locationText || 'Ottawa',
      address: addressGuess,
      lat: coords.lat,
      lng: coords.lng,
      type: normalizeType(typeText),
      models: [],
      priceFrom,
      priceFromFormatted: formatPrice(priceFrom),
      status: 'selling',
      completionYear: null,
      description: '',
      sourceUrl: detailUrl || LISTING_URL,
      sourceName: 'mattamyhomes.com',
      imageUrl: imageUrl.startsWith('http') ? imageUrl : (imageUrl ? BASE_URL + imageUrl : ''),
      scrapedAt: new Date().toISOString(),
    });

    console.log(`  [mattamy] ${name} — ${formatPrice(priceFrom) || 'price unknown'}`);
    await sleep(200);
  }

  console.log(`[mattamy] Done — ${builds.length} builds scraped`);
  return builds;
}

function parseNextData(data) {
  // Mattamy Next.js structure — communities may be in various props paths
  const pageProps = data?.props?.pageProps || {};
  const communities =
    pageProps.communities ||
    pageProps.developments ||
    pageProps.initialData?.communities ||
    [];

  if (!Array.isArray(communities) || communities.length === 0) return [];

  return communities
    .filter((c) => {
      // Only Ottawa communities
      const loc = (c.city || c.province || c.region || '').toLowerCase();
      return loc.includes('ottawa') || loc.includes('ontario');
    })
    .map((c) => ({
      id: `mattamy-${slugify(c.name || c.title || '')}`,
      name: c.name || c.title || '',
      builder: 'Mattamy Homes',
      community: c.neighbourhood || c.city || 'Ottawa',
      address: c.address || `${c.name}, Ottawa, ON`,
      lat: c.latitude ? parseFloat(c.latitude) : null,
      lng: c.longitude ? parseFloat(c.longitude) : null,
      type: normalizeType(c.homeType || c.productType || c.type || ''),
      models: [],
      priceFrom: normalizePrice(c.priceFrom || c.startingPrice),
      priceFromFormatted: formatPrice(normalizePrice(c.priceFrom || c.startingPrice)),
      status: (c.status || 'selling').toLowerCase(),
      completionYear: c.completionYear || null,
      description: c.description || '',
      sourceUrl: c.url ? (c.url.startsWith('http') ? c.url : BASE_URL + c.url) : LISTING_URL,
      sourceName: 'mattamyhomes.com',
      imageUrl: c.imageUrl || c.heroImage || '',
      scrapedAt: new Date().toISOString(),
    }))
    .filter((b) => b.name);
}

async function playwrightFallback() {
  console.warn('[mattamy] Attempting Playwright fallback...');
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(LISTING_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('[class*="community"], [class*="card"]', { timeout: 10000 }).catch(() => {});
    const html = await page.content();
    await browser.close();

    const $ = cheerio.load(html);
    const builds = [];

    $('[class*="CommunityCard"], [class*="community-card"]').each((_, el) => {
      const name = $(el).find('h2, h3, [class*="Title"]').first().text().trim();
      const priceText = $(el).find('[class*="Price"]').first().text().trim();
      if (name) {
        builds.push({
          id: `mattamy-${slugify(name)}`,
          name,
          builder: 'Mattamy Homes',
          community: 'Ottawa',
          address: `${name}, Ottawa, ON`,
          lat: null,
          lng: null,
          type: 'unknown',
          models: [],
          priceFrom: normalizePrice(priceText),
          priceFromFormatted: formatPrice(normalizePrice(priceText)),
          status: 'selling',
          completionYear: null,
          description: '',
          sourceUrl: LISTING_URL,
          sourceName: 'mattamyhomes.com',
          imageUrl: '',
          scrapedAt: new Date().toISOString(),
        });
      }
    });

    console.log(`[mattamy] Playwright found ${builds.length} builds`);
    return builds;
  } catch (err) {
    console.error(`[mattamy] Playwright fallback failed: ${err.message}`);
    return [];
  }
}

function normalizeType(str) {
  if (!str) return 'unknown';
  const s = str.toLowerCase();
  if (s.includes('condo') || s.includes('apartment') || s.includes('urban')) return 'condo';
  if (s.includes('townhome') || s.includes('townhouse') || s.includes('town')) return 'townhouse';
  if (s.includes('semi')) return 'semi-detached';
  if (s.includes('single') || s.includes('detached')) return 'single-family';
  return 'unknown';
}
