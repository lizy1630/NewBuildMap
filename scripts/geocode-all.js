#!/usr/bin/env node
/**
 * Batch geocode all communities using Google Maps API
 * Updates lat/lng in public/data/builds.json based on address
 *
 * Usage: node scripts/geocode-all.js
 */
import axios from 'axios';
import { readFileSync, writeFileSync } from 'fs';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!API_KEY) {
  console.error('❌ Error: GOOGLE_MAPS_API_KEY not found in .env');
  process.exit(1);
}

const BUILDS_FILE = resolve(__dirname, '../public/data/builds.json');

async function geocodeAddress(address, city = 'Ottawa, Ontario') {
  try {
    const fullAddress = `${address}, ${city}`;
    const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: fullAddress, key: API_KEY },
      timeout: 5000
    });

    if (res.data.results && res.data.results.length > 0) {
      const loc = res.data.results[0].geometry.location;
      return {
        lat: Math.round(loc.lat * 10000) / 10000,
        lng: Math.round(loc.lng * 10000) / 10000,
        ok: true
      };
    }
    return { ok: false, error: 'No results found' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function run() {
  console.log('🔍 Geocoding all communities...\n');

  const data = JSON.parse(readFileSync(BUILDS_FILE, 'utf8'));
  let updated = 0;
  let failed = 0;

  for (const build of data.builds) {
    const result = await geocodeAddress(build.address);
    if (result.ok) {
      console.log(`✓ ${build.name.padEnd(30)} → ${result.lat}, ${result.lng}`);
      build.lat = result.lat;
      build.lng = result.lng;
      updated++;
    } else {
      console.log(`✗ ${build.name.padEnd(30)} → ${result.error}`);
      failed++;
    }
    // Rate limit: Google allows 50 req/sec per user, add small delay
    await new Promise(r => setTimeout(r, 150));
  }

  writeFileSync(BUILDS_FILE, JSON.stringify(data, null, 2));

  console.log(`\n✅ Done!`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Total: ${data.builds.length}`);
  console.log(`\n📝 Saved to ${BUILDS_FILE}`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
