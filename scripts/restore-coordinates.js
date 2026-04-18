#!/usr/bin/env node
/**
 * Restore Locked Coordinates
 *
 * After any scraper or data update, this script MUST be run to ensure
 * community coordinates are NOT changed from their locked values.
 *
 * Usage: node scripts/restore-coordinates.js
 *
 * This should be called AFTER any scraper run that modifies builds.json
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const BUILDS_FILE = resolve('./public/data/builds.json');
const LOCK_FILE = resolve('.coordinate-lock.json');

try {
  // Read coordinate lock
  const coordinateLock = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));

  // Read current builds
  const data = JSON.parse(readFileSync(BUILDS_FILE, 'utf8'));

  let restored = 0;
  let notFound = 0;

  // Restore coordinates from lock file
  data.builds.forEach(build => {
    if (coordinateLock[build.id]) {
      const locked = coordinateLock[build.id];
      if (build.lat !== locked.lat || build.lng !== locked.lng) {
        console.log(`🔄 Restoring ${build.name}: [${build.lat}, ${build.lng}] → [${locked.lat}, ${locked.lng}]`);
        build.lat = locked.lat;
        build.lng = locked.lng;
        restored++;
      }
    } else {
      notFound++;
    }
  });

  // Save updated builds
  writeFileSync(BUILDS_FILE, JSON.stringify(data, null, 2));

  console.log(`\n✅ Coordinate restoration complete`);
  console.log(`   Restored: ${restored}`);
  console.log(`   Unchanged: ${data.builds.length - restored - notFound}`);
  if (notFound > 0) {
    console.log(`   ⚠️  New communities (not in lock): ${notFound}`);
  }
} catch (error) {
  console.error('❌ Error:', error.message);
  console.error('\nMake sure you have run: node scripts/protect-coordinates.js');
  process.exit(1);
}
