/**
 * Scraper for newinhomes.com — Ottawa new homes aggregator
 * URL: https://www.newinhomes.com/new-homes/ontario/ottawa
 */
import * as cheerio from 'cheerio';
import { fetchHTML, normalizePrice, formatPrice, slugify, sleep } from '../utils.js';
import { geocode } from '../geocode.js';

const BASE_URL = 'https://www.newinhomes.com';
const LISTING_URL = 'https://www.newinhomes.com/new-homes/ontario/ottawa';

export async function scrape() {
  console.log('[newinhomes] Starting scrape...');
  const builds = [];

  let html;
  try {
    html = await fetchHTML(LISTING_URL);
  } catch (err) {
    console.error(`[newinhomes] Failed to fetch: ${err.message}`);
    return [];
  }

  const $ = cheerio.load(html);

  // newinhomes listing cards
  const cards = $('.development-listing, .listing-card, .community-card, article[class*="listing"], [class*="development"]').not('script, style');

  if (cards.length === 0) {
    console.warn('[newinhomes] Zero cards found — HTML snippet:');
    console.warn(html.slice(0, 500));
    return [];
  }

  console.log(`[newinhomes] Found ${cards.length} listings`);

  for (let i = 0; i < cards.length; i++) {
    const card = cards.eq(i);

    const name = card.find('h2, h3, .development-name, .listing-name, [class*="name"]').first().text().trim();
    if (!name) continue;

    const builder = card.find('.builder-name, [class*="builder"], .developer').first().text().trim() || 'Unknown Builder';
    const linkHref = card.find('a').first().attr('href') || '';
    const detailUrl = linkHref.startsWith('http') ? linkHref : BASE_URL + linkHref;

    const priceText = card.find('[class*="price"], .price-from, .starting-price').first().text().trim();
    const typeText = card.find('[class*="type"], .home-type, .dwelling-type').first().text().trim();
    const communityText = card.find('[class*="neighbourhood"], .neighbourhood, .community, [class*="location"]').first().text().trim();
    const cityText = card.find('[class*="city"], .city').first().text().trim();
    const imageUrl = card.find('img').first().attr('src') || card.find('img').first().attr('data-src') || '';

    const priceFrom = normalizePrice(priceText);
    const addressGuess = communityText
      ? `${communityText}, Ottawa, ON`
      : `${name}, Ottawa, ON`;

    const coords = await geocode(addressGuess);

    const build = {
      id: `nih-${slugify(builder)}-${slugify(name)}`,
      name,
      builder,
      community: communityText || cityText || 'Ottawa',
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
      sourceName: 'newinhomes.com',
      imageUrl: imageUrl.startsWith('http') ? imageUrl : (imageUrl ? BASE_URL + imageUrl : ''),
      scrapedAt: new Date().toISOString(),
    };

    builds.push(build);
    console.log(`  [newinhomes] ${name} (${builder}) — ${formatPrice(priceFrom) || 'price unknown'}`);

    await sleep(300);
  }

  console.log(`[newinhomes] Done — ${builds.length} builds scraped`);
  return builds;
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
