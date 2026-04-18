#!/usr/bin/env node
/**
 * Coordinate Protection Lock
 *
 * This script locks the current coordinates in public/data/builds.json
 * and creates a coordinate map that MUST be restored after any data update.
 *
 * Usage: node scripts/protect-coordinates.js
 *
 * This creates .coordinate-lock.json which acts as a safeguard.
 * Any scraper or data update MUST restore coordinates from this lock file.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const BUILDS_FILE = resolve('./public/data/builds.json');
const LOCK_FILE = resolve('.coordinate-lock.json');

// Read current builds
const data = JSON.parse(readFileSync(BUILDS_FILE, 'utf8'));

// Create coordinate lock: id -> {lat, lng}
const coordinateLock = {};
data.builds.forEach(build => {
  coordinateLock[build.id] = {
    lat: build.lat,
    lng: build.lng
  };
});

// Save lock file
writeFileSync(LOCK_FILE, JSON.stringify(coordinateLock, null, 2));

console.log('🔒 Coordinate lock created');
console.log(`   Locked ${Object.keys(coordinateLock).length} communities`);
console.log(`   File: ${LOCK_FILE}`);
console.log('\n⚠️  IMPORTANT: This lock file MUST be committed to Git');
console.log('   Any data update MUST restore coordinates from this file');
