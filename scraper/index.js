/**
 * Ottawa New Build Map — Scraper Orchestrator
 * Run: node scraper/index.js
 *
 * Runs all source scrapers sequentially, merges results,
 * geocodes missing coordinates, runs the history diff, and writes builds.json.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { scrape as scrapeClaridge } from './sources/claridge.js';
import { scrape as scrapeNewInHomes } from './sources/newinhomes.js';
import { scrape as scrapeMinto } from './sources/minto.js';
import { scrape as scrapeMattamy } from './sources/mattamy.js';
import { scrape as scrapeTartan } from './sources/tartan.js';
import { scrape as scrapeRichcraft } from './sources/richcraft.js';
import { scrape as scrapeCaivan } from './sources/caivan.js';
import { scrape as scrapeHN } from './sources/hn.js';
import { scrape as scrapeUniform } from './sources/uniform.js';
import { scrape as scrapeCardel } from './sources/cardel.js';
import { scrape as scrapeUrbandale } from './sources/urbandale.js';
import { scrape as scrapeTamarack } from './sources/tamarack.js';
import { geocode } from './geocode.js';
import { runHistoryDiff } from './history.js';
import { slugify } from './utils.js';

const BUILDS_PATH = new URL('../public/data/builds.json', import.meta.url).pathname;
const RAW_DIR = new URL('../public/data/raw', import.meta.url).pathname;

mkdirSync(RAW_DIR, { recursive: true });

const SOURCES = [
  { name: 'claridge', fn: scrapeClaridge },
  { name: 'newinhomes', fn: scrapeNewInHomes },
  { name: 'minto', fn: scrapeMinto },
  { name: 'mattamy', fn: scrapeMattamy },
  { name: 'tartan', fn: scrapeTartan },
  { name: 'richcraft', fn: scrapeRichcraft },
  { name: 'caivan', fn: scrapeCaivan },
  { name: 'hn', fn: scrapeHN },
  { name: 'uniform', fn: scrapeUniform },
  { name: 'cardel', fn: scrapeCardel },
  { name: 'urbandale', fn: scrapeUrbandale },
  { name: 'tamarack', fn: scrapeTamarack },
];

async function run() {
  console.log('\n=== Ottawa New Build Map — Scraper ===\n');
  const startTime = Date.now();
  const allBuilds = [];
  const sourceResults = {};

  for (const source of SOURCES) {
    console.log(`\n--- Running ${source.name} ---`);
    try {
      const builds = await source.fn();
      sourceResults[source.name] = builds;
      allBuilds.push(...builds);
      console.log(`[${source.name}] ✓ ${builds.length} builds`);

      // Write raw cache
      writeFileSync(
        `${RAW_DIR}/${source.name}.json`,
        JSON.stringify({ scrapedAt: new Date().toISOString(), builds }, null, 2)
      );
    } catch (err) {
      console.error(`[${source.name}] ✗ Failed: ${err.message}`);
      sourceResults[source.name] = [];
    }
  }

  console.log(`\n--- Merging ${allBuilds.length} total builds ---`);

  // Deduplicate by normalized (builder + name)
  const seen = new Map();
  const merged = [];
  for (const build of allBuilds) {
    const key = `${slugify(build.builder)}-${slugify(build.name)}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      merged.push(build);
    } else {
      console.log(`  [dedup] Skipping duplicate: ${build.name} (${build.builder}) from ${build.sourceName}`);
    }
  }
  console.log(`  Merged: ${merged.length} unique builds (${allBuilds.length - merged.length} duplicates removed)`);

  // Tag tax-included builders (price shown includes HST — can show tax-free equivalent)
  const TAX_INCLUDED_BUILDERS = new Set(['Richcraft Homes', 'Minto Communities', 'Mattamy Homes', 'HN Homes']);
  merged.forEach(b => { b.taxIncluded = TAX_INCLUDED_BUILDERS.has(b.builder); });

  // Geocode any builds still missing coordinates
  let geocodedCount = 0;
  for (const build of merged) {
    if (!build.lat && build.address) {
      const coords = await geocode(build.address);
      build.lat = coords.lat;
      build.lng = coords.lng;
      if (coords.lat) geocodedCount++;
    }
  }
  if (geocodedCount > 0) {
    console.log(`  Geocoded ${geocodedCount} additional builds`);
  }

  const geocodeFailed = merged.filter((b) => !b.lat).length;
  if (geocodeFailed > 0) {
    console.warn(`  ⚠ ${geocodeFailed} builds could not be geocoded (will appear in "unlocated" list)`);
  }

  // Run history diff
  console.log('\n--- Running history diff ---');
  const historyResult = runHistoryDiff(merged);

  // Write final builds.json
  const output = {
    generated: new Date().toISOString(),
    count: merged.length,
    geocodeFailed,
    builds: merged,
  };

  writeFileSync(BUILDS_PATH, JSON.stringify(output, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Done in ${elapsed}s ===`);
  console.log(`  Total builds: ${merged.length}`);
  console.log(`  On map: ${merged.length - geocodeFailed}`);
  console.log(`  Unlocated: ${geocodeFailed}`);
  console.log(`  History: +${historyResult.newBuildCount} new, ${historyResult.priceChangeCount} price changes`);
  console.log(`  Output: data/builds.json\n`);
}

run().catch((err) => {
  console.error('Fatal scraper error:', err);
  process.exit(1);
});
