/**
 * History diff engine.
 * Compares a new scrape result against the previous builds.json snapshot,
 * detects changes, and updates history/prices.json and history/releases.json.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

const BUILDS_PATH = new URL('../public/data/builds.json', import.meta.url).pathname;
const PRICES_PATH = new URL('../public/data/history/prices.json', import.meta.url).pathname;
const RELEASES_PATH = new URL('../public/data/history/releases.json', import.meta.url).pathname;

function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/**
 * Run the diff between the previous snapshot and the new builds array.
 * Mutates history files and returns a summary of changes.
 *
 * @param {Array} newBuilds - freshly scraped array of build objects
 * @returns {{ newBuildCount, priceChangeCount, newModelCount, events: Array }}
 */
export function runHistoryDiff(newBuilds) {
  const previous = loadJSON(BUILDS_PATH, { builds: [] });
  const prevMap = new Map((previous.builds || []).map((b) => [b.id, b]));

  const prices = loadJSON(PRICES_PATH, {});
  const releases = loadJSON(RELEASES_PATH, []);

  const today = new Date().toISOString().slice(0, 10);
  const events = [];

  for (const build of newBuilds) {
    const prev = prevMap.get(build.id);

    // --- New build ---
    if (!prev) {
      events.push({
        date: today,
        type: 'new_build',
        buildId: build.id,
        name: build.name,
        builder: build.builder,
        community: build.community,
        priceFrom: build.priceFrom,
      });
    } else {
      // --- Price change on base priceFrom ---
      if (prev.priceFrom && build.priceFrom && prev.priceFrom !== build.priceFrom) {
        events.push({
          date: today,
          type: 'price_change',
          buildId: build.id,
          name: build.name,
          builder: build.builder,
          oldPrice: prev.priceFrom,
          newPrice: build.priceFrom,
          delta: build.priceFrom - prev.priceFrom,
        });
      }

      // --- New models ---
      const prevModelNames = new Set((prev.models || []).map((m) => m.name));
      for (const model of build.models || []) {
        if (!prevModelNames.has(model.name)) {
          events.push({
            date: today,
            type: 'new_model',
            buildId: build.id,
            name: build.name,
            builder: build.builder,
            model: model.name,
            priceFrom: model.priceFrom,
          });
        }
      }

      // --- Model price changes ---
      const prevModelMap = new Map((prev.models || []).map((m) => [m.name, m]));
      for (const model of build.models || []) {
        const prevModel = prevModelMap.get(model.name);
        if (prevModel && prevModel.priceFrom && model.priceFrom && prevModel.priceFrom !== model.priceFrom) {
          events.push({
            date: today,
            type: 'price_change',
            buildId: build.id,
            name: build.name,
            builder: build.builder,
            model: model.name,
            oldPrice: prevModel.priceFrom,
            newPrice: model.priceFrom,
            delta: model.priceFrom - prevModel.priceFrom,
          });
        }
      }
    }

    // --- Append price snapshot ---
    if (build.priceFrom) {
      if (!prices[build.id]) prices[build.id] = [];
      const lastSnapshot = prices[build.id][prices[build.id].length - 1];
      // Only append if price changed or it's the first entry
      if (!lastSnapshot || lastSnapshot.priceFrom !== build.priceFrom) {
        const snapshot = { date: today, priceFrom: build.priceFrom };
        if (build.models && build.models.length > 0) {
          snapshot.models = {};
          for (const m of build.models) {
            if (m.name && m.priceFrom) snapshot.models[m.name] = m.priceFrom;
          }
        }
        prices[build.id].push(snapshot);
      }
    }
  }

  // Append new events to releases (newest first)
  releases.unshift(...events);

  writeFileSync(PRICES_PATH, JSON.stringify(prices, null, 2));
  writeFileSync(RELEASES_PATH, JSON.stringify(releases, null, 2));

  const newBuildCount = events.filter((e) => e.type === 'new_build').length;
  const priceChangeCount = events.filter((e) => e.type === 'price_change').length;
  const newModelCount = events.filter((e) => e.type === 'new_model').length;

  if (events.length > 0) {
    console.log(`[history] ${newBuildCount} new builds, ${priceChangeCount} price changes, ${newModelCount} new models`);
  } else {
    console.log('[history] No changes detected');
  }

  return { newBuildCount, priceChangeCount, newModelCount, events };
}
