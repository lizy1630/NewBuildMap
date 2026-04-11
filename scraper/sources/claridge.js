/**
 * Scraper for Claridge Homes — claridgehomes.com/communities/
 * Claridge is a major Ottawa builder with a relatively static HTML site.
 */
import * as cheerio from 'cheerio';
import { fetchHTML, normalizePrice, formatPrice, slugify } from '../utils.js';
import { geocode } from '../geocode.js';

const BASE_URL = 'https://claridgehomes.com';
const LISTING_URL = 'https://claridgehomes.com/communities/';

export async function scrape() {
  console.log('[claridge] Starting scrape...');
  const builds = [];

  let html;
  try {
    html = await fetchHTML(LISTING_URL);
  } catch (err) {
    console.error(`[claridge] Failed to fetch listing page: ${err.message}`);
    if (err.response) {
      console.error(`[claridge] Raw HTML snippet: ${String(err.response.data || '').slice(0, 300)}`);
    }
    return [];
  }

  const $ = cheerio.load(html);

  // Claridge community cards — try multiple selector patterns
  const cards = $('.community-item, .community-card, article.community, .communities-list .item, [class*="community"]').not('script');

  if (cards.length === 0) {
    console.warn('[claridge] Zero cards found — HTML snippet for debug:');
    console.warn(html.slice(0, 500));
    return [];
  }

  console.log(`[claridge] Found ${cards.length} community cards`);

  for (let i = 0; i < cards.length; i++) {
    const card = cards.eq(i);

    const name = card.find('h2, h3, h4, .community-name, .title').first().text().trim();
    if (!name) continue;

    const linkHref = card.find('a').first().attr('href') || '';
    const detailUrl = linkHref.startsWith('http') ? linkHref : BASE_URL + linkHref;

    const priceText = card.find('[class*="price"], .price, .from-price').first().text().trim();
    const typeText = card.find('[class*="type"], .type, .home-type').first().text().trim();
    const communityText = card.find('[class*="neighbourhood"], [class*="community-area"], .neighbourhood').first().text().trim();
    const imageUrl = card.find('img').first().attr('src') || card.find('img').first().attr('data-src') || '';

    const priceFrom = normalizePrice(priceText);

    const addressGuess = `${name}, Ottawa, ON`;
    const coords = await geocode(addressGuess);

    const build = {
      id: `claridge-${slugify(name)}`,
      name,
      builder: 'Claridge Homes',
      community: communityText || 'Ottawa',
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
      sourceName: 'claridgehomes.com',
      imageUrl: imageUrl.startsWith('http') ? imageUrl : (imageUrl ? BASE_URL + imageUrl : ''),
      scrapedAt: new Date().toISOString(),
    };

    builds.push(build);
    console.log(`  [claridge] ${name} — ${formatPrice(priceFrom) || 'price unknown'}`);
  }

  console.log(`[claridge] Done — ${builds.length} builds scraped`);
  return builds;
}

function normalizeType(str) {
  if (!str) return 'unknown';
  const s = str.toLowerCase();
  if (s.includes('condo') || s.includes('apartment')) return 'condo';
  if (s.includes('townhome') || s.includes('townhouse')) return 'townhouse';
  if (s.includes('semi')) return 'semi-detached';
  if (s.includes('single') || s.includes('detached')) return 'single-family';
  return 'unknown';
}
