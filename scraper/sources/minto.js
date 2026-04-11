/**
 * Scraper for Minto Communities — mintohomes.com
 * Minto is one of Ottawa's largest builders (Barrhaven, Kanata, etc.)
 * Their site uses React; we check for embedded JSON first, fall back to Playwright.
 */
import * as cheerio from 'cheerio';
import { fetchHTML, normalizePrice, formatPrice, slugify, extractEmbeddedJSON, sleep } from '../utils.js';
import { geocode } from '../geocode.js';

const BASE_URL = 'https://www.mintohomes.com';
const LISTING_URL = 'https://www.mintohomes.com/new-homes/ottawa';

export async function scrape() {
  console.log('[minto] Starting scrape...');

  let html;
  try {
    html = await fetchHTML(LISTING_URL);
  } catch (err) {
    console.error(`[minto] Failed to fetch: ${err.message}`);
    return [];
  }

  // Try embedded JSON first (faster, more reliable)
  const embedded = extractEmbeddedJSON(html);
  if (embedded) {
    const builds = parseNextData(embedded);
    if (builds.length > 0) {
      console.log(`[minto] Parsed ${builds.length} builds from embedded JSON`);
      return builds;
    }
  }

  // Fall back to HTML parsing
  const $ = cheerio.load(html);
  const cards = $('[class*="community"], [class*="project"], article, .card').not('script, style, header, footer, nav');

  if (cards.length === 0) {
    console.warn('[minto] Zero cards found — HTML snippet:');
    console.warn(html.slice(0, 500));
    return await playwrightFallback();
  }

  const builds = [];
  console.log(`[minto] Found ${cards.length} candidate elements`);

  for (let i = 0; i < cards.length; i++) {
    const card = cards.eq(i);
    const name = card.find('h2, h3, h4, [class*="title"], [class*="name"]').first().text().trim();
    if (!name || name.length < 3) continue;

    const priceText = card.find('[class*="price"], [class*="from"]').first().text().trim();
    const typeText = card.find('[class*="type"], [class*="home-type"]').first().text().trim();
    const locationText = card.find('[class*="location"], [class*="community"], [class*="city"]').first().text().trim();
    const imageUrl = card.find('img').first().attr('src') || '';
    const linkHref = card.find('a').first().attr('href') || '';
    const detailUrl = linkHref.startsWith('http') ? linkHref : BASE_URL + linkHref;

    const priceFrom = normalizePrice(priceText);
    const addressGuess = locationText ? `${locationText}, Ottawa, ON` : `${name}, Ottawa, ON`;
    const coords = await geocode(addressGuess);

    builds.push({
      id: `minto-${slugify(name)}`,
      name,
      builder: 'Minto Communities',
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
      sourceName: 'mintohomes.com',
      imageUrl: imageUrl.startsWith('http') ? imageUrl : (imageUrl ? BASE_URL + imageUrl : ''),
      scrapedAt: new Date().toISOString(),
    });

    console.log(`  [minto] ${name} — ${formatPrice(priceFrom) || 'price unknown'}`);
    await sleep(200);
  }

  console.log(`[minto] Done — ${builds.length} builds scraped`);
  return builds;
}

function parseNextData(data) {
  // Try to find community/project arrays in Next.js page props
  const pageProps = data?.props?.pageProps || {};
  const communities = pageProps.communities || pageProps.projects || pageProps.homes || [];
  if (!Array.isArray(communities) || communities.length === 0) return [];

  return communities.map((c) => ({
    id: `minto-${slugify(c.name || c.title || '')}`,
    name: c.name || c.title || '',
    builder: 'Minto Communities',
    community: c.neighbourhood || c.community || c.city || 'Ottawa',
    address: c.address || `${c.name}, Ottawa, ON`,
    lat: c.lat ? parseFloat(c.lat) : null,
    lng: c.lng || c.lon ? parseFloat(c.lng || c.lon) : null,
    type: normalizeType(c.homeType || c.type || ''),
    models: (c.models || []).map((m) => ({
      name: m.name || '',
      sqft: m.sqft || m.squareFeet || null,
      beds: m.beds || m.bedrooms || null,
      baths: m.baths || m.bathrooms || null,
      priceFrom: normalizePrice(m.price || m.priceFrom),
    })),
    priceFrom: normalizePrice(c.priceFrom || c.startingPrice || c.price),
    priceFromFormatted: formatPrice(normalizePrice(c.priceFrom || c.startingPrice || c.price)),
    status: (c.status || 'selling').toLowerCase(),
    completionYear: c.completionYear || null,
    description: c.description || '',
    sourceUrl: c.url ? (c.url.startsWith('http') ? c.url : BASE_URL + c.url) : LISTING_URL,
    sourceName: 'mintohomes.com',
    imageUrl: c.imageUrl || c.image || '',
    scrapedAt: new Date().toISOString(),
  })).filter((b) => b.name);
}

async function playwrightFallback() {
  console.warn('[minto] Attempting Playwright fallback...');
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(LISTING_URL, { waitUntil: 'networkidle', timeout: 30000 });
    const html = await page.content();
    await browser.close();

    const $ = cheerio.load(html);
    const builds = [];
    $('[class*="community"], [class*="project"]').each((_, el) => {
      const name = $(el).find('h2, h3, [class*="title"]').first().text().trim();
      if (name) builds.push({ name, builder: 'Minto Communities', community: 'Ottawa', lat: null, lng: null });
    });
    return builds;
  } catch (err) {
    console.error(`[minto] Playwright fallback failed: ${err.message}`);
    return [];
  }
}

function normalizeType(str) {
  if (!str) return 'unknown';
  const s = str.toLowerCase();
  if (s.includes('condo') || s.includes('apartment')) return 'condo';
  if (s.includes('townhome') || s.includes('townhouse') || s.includes('town')) return 'townhouse';
  if (s.includes('semi')) return 'semi-detached';
  if (s.includes('single') || s.includes('detached')) return 'single-family';
  return 'unknown';
}
