/**
 * Scraper for Tartan Homes — tartanhomes.com
 * Tartan is an Ottawa-focused builder, simpler static site.
 */
import * as cheerio from 'cheerio';
import { fetchHTML, normalizePrice, formatPrice, slugify, sleep } from '../utils.js';
import { geocode } from '../geocode.js';

const BASE_URL = 'https://www.tartanhomes.com';
const LISTING_URL = 'https://www.tartanhomes.com/communities';

export async function scrape() {
  console.log('[tartan] Starting scrape...');
  const builds = [];

  let html;
  try {
    html = await fetchHTML(LISTING_URL);
  } catch (err) {
    // Try alternate URL pattern
    try {
      html = await fetchHTML(BASE_URL);
    } catch (err2) {
      console.error(`[tartan] Failed to fetch: ${err2.message}`);
      return [];
    }
  }

  const $ = cheerio.load(html);

  const cards = $(
    '.community, .community-item, .community-card, article, [class*="community"], .development'
  ).not('script, style, header, footer, nav');

  if (cards.length === 0) {
    console.warn('[tartan] Zero cards found — HTML snippet:');
    console.warn(html.slice(0, 500));
    return [];
  }

  console.log(`[tartan] Found ${cards.length} community elements`);

  for (let i = 0; i < cards.length; i++) {
    const card = cards.eq(i);
    const name = card.find('h2, h3, h4, [class*="title"], [class*="name"]').first().text().trim();
    if (!name || name.length < 3) continue;

    const priceText = card.find('[class*="price"], .price, .from').first().text().trim();
    const typeText = card.find('[class*="type"], .type').first().text().trim();
    const locationText = card.find('[class*="location"], [class*="city"], [class*="community"]').first().text().trim();
    const imageUrl = card.find('img').first().attr('src') || card.find('img').first().attr('data-src') || '';
    const linkHref = card.find('a').first().attr('href') || '';
    const detailUrl = linkHref.startsWith('http') ? linkHref : BASE_URL + linkHref;

    const priceFrom = normalizePrice(priceText);
    const addressGuess = locationText ? `${locationText}, Ottawa, ON` : `${name}, Ottawa, ON`;
    const coords = await geocode(addressGuess);

    builds.push({
      id: `tartan-${slugify(name)}`,
      name,
      builder: 'Tartan Homes',
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
      sourceName: 'tartanhomes.com',
      imageUrl: imageUrl.startsWith('http') ? imageUrl : (imageUrl ? BASE_URL + imageUrl : ''),
      scrapedAt: new Date().toISOString(),
    });

    console.log(`  [tartan] ${name} — ${formatPrice(priceFrom) || 'price unknown'}`);
    await sleep(300);
  }

  console.log(`[tartan] Done — ${builds.length} builds scraped`);
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
