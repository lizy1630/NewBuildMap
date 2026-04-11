import axios from 'axios';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { sleep } from './utils.js';

const CACHE_PATH = new URL('../public/data/raw/geocode-cache.json', import.meta.url).pathname;
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const RATE_LIMIT_MS = 1200; // Nominatim ToS: 1 req/sec — we use 1.2s to be safe

let cache = {};

function loadCache() {
  if (existsSync(CACHE_PATH)) {
    try {
      cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    } catch {
      cache = {};
    }
  }
}

function saveCache() {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

let lastRequestTime = 0;

/**
 * Geocode an address string to { lat, lng }.
 * Returns { lat: null, lng: null } on failure (never throws).
 */
export async function geocode(address) {
  if (!address) return { lat: null, lng: null };

  const key = address.toLowerCase().trim();

  if (cache[key]) {
    return cache[key];
  }

  // Rate limiting
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastRequestTime = Date.now();

  try {
    const res = await axios.get(NOMINATIM, {
      timeout: 10000,
      params: {
        q: address,
        format: 'json',
        limit: 1,
        countrycodes: 'ca',
      },
      headers: {
        'User-Agent': 'OttawaNewBuildMap/1.0 (contact@example.com)',
        Accept: 'application/json',
      },
    });

    if (res.data && res.data.length > 0) {
      const result = {
        lat: parseFloat(res.data[0].lat),
        lng: parseFloat(res.data[0].lon),
      };
      cache[key] = result;
      saveCache();
      return result;
    }

    console.warn(`  [geocode] No result for: ${address}`);
    cache[key] = { lat: null, lng: null };
    saveCache();
    return { lat: null, lng: null };
  } catch (err) {
    console.warn(`  [geocode] Error for "${address}": ${err.message}`);
    return { lat: null, lng: null };
  }
}

// Load cache on module import
loadCache();
