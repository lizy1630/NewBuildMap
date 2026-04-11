import axios from 'axios';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch HTML from a URL with realistic browser headers.
 * Throws on 4xx/5xx with a clear message.
 */
export async function fetchHTML(url, options = {}) {
  const res = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-CA,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      ...options.headers,
    },
    ...options,
  });
  return res.data;
}

/**
 * Promise-based sleep.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert price strings like "From $649,900" or "$649K" to integer cents.
 * Returns null if no number found.
 */
export function normalizePrice(str) {
  if (!str) return null;
  const s = String(str).replace(/,/g, '').trim();

  // Handle "K" shorthand: $649K → 649000
  const kMatch = s.match(/\$?([\d.]+)\s*[Kk]/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);

  // Handle "M" shorthand
  const mMatch = s.match(/\$?([\d.]+)\s*[Mm]/);
  if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1000000);

  // Handle plain number with optional $ prefix
  const numMatch = s.match(/\$?([\d]+)/);
  if (numMatch) return parseInt(numMatch[1], 10);

  return null;
}

/**
 * Format an integer price as "$649,900"
 */
export function formatPrice(num) {
  if (!num) return null;
  return '$' + num.toLocaleString('en-CA');
}

/**
 * Convert "Claridge Homes" → "claridge-homes"
 */
export function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Try to extract __NEXT_DATA__ or window.__data__ JSON from a page's HTML.
 * Returns parsed object or null.
 */
export function extractEmbeddedJSON(html) {
  // Next.js pattern
  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try { return JSON.parse(nextMatch[1]); } catch {}
  }
  return null;
}
