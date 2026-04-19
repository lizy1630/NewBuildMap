/**
 * Scraper for Tamarack Homes Ottawa — tamarackhomes.com
 *
 * Data lives as inline JSON in the /inventory/ page:
 *   const propertiesData = [...]
 *
 * Ottawa communities (5):
 *   Cardinal Creek Village → Orléans
 *   Findlay Creek Village  → Findlay Creek
 *   Idylea                 → Stittsville
 *   The Meadows            → Nepean
 *   Westwood               → Stittsville
 *
 * Strategy:
 *   - Parse propertiesData, filter region === "Ottawa"
 *   - Group by community, then by home_model (deduplicate move-in-ready vs under-construction)
 *   - Use lowest price across all units of that model as priceFrom
 *   - Save one image per model (first seen)
 *   - Write price report JSON per community
 */

import axios from 'axios';
import { writeFileSync, mkdirSync, existsSync, createWriteStream } from 'fs';
import { slugify, sleep } from '../utils.js';
import { geocode } from '../geocode.js';

const INVENTORY_URL  = 'https://tamarackhomes.com/inventory/';
const REPORTS_DIR    = new URL('../../public/data/tamarack-price-reports', import.meta.url).pathname;
const IMAGES_DIR     = new URL('../../public/images/tamarack', import.meta.url).pathname;
const FEAT_TOWNS     = '/data/tamarack-price-reports/tamarack-towns-feature-sheet.pdf';
const FEAT_SINGLES   = '/data/tamarack-price-reports/tamarack-singles-feature-sheet.pdf';

const COMMUNITY_META = {
  'Cardinal Creek Village': { community: 'Orléans',      area: 'Orléans',      type: 'mixed'   },
  'Findlay Creek Village':  { community: 'Findlay Creek', area: 'Findlay Creek', type: 'mixed'   },
  'Idylea':                 { community: 'Stittsville',   area: 'Stittsville',  type: 'mixed'   },
  'The Meadows':            { community: 'Nepean',        area: 'Ottawa Urban', type: 'mixed'   },
  'Westwood':               { community: 'Stittsville',   area: 'Stittsville',  type: 'mixed'   },
};

// Address overrides (intersection known)
const COMMUNITY_ADDRESS = {
  'Cardinal Creek Village': 'Cardinal Creek Village, Orléans, Ottawa, ON',
  'Findlay Creek Village':  'Findlay Creek, Ottawa, ON',
  'Idylea':                 'Fernbank Rd & Cope Dr, Stittsville, Ottawa, ON',
  'The Meadows':            'The Meadows, Nepean, Ottawa, ON',
  'Westwood':               'Stittsville, Ottawa, ON',
};

function fmtPrice(n) {
  if (!n) return null;
  return '$' + Number(n).toLocaleString('en-CA');
}

function parsePrice(s) {
  if (!s) return null;
  const n = parseInt(String(s).replace(/[^0-9]/g, ''));
  return isNaN(n) ? null : n;
}

async function downloadImage(url, dest) {
  if (!url || existsSync(dest)) return;
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' } });
    writeFileSync(dest, res.data);
  } catch { /* skip */ }
}

export async function scrape() {
  mkdirSync(REPORTS_DIR, { recursive: true });
  mkdirSync(IMAGES_DIR,  { recursive: true });

  console.log('Tamarack: fetching inventory page…');
  const html = (await axios.get(INVENTORY_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000,
  })).data;

  // Extract inline propertiesData JSON
  const match = html.match(/const\s+propertiesData\s*=\s*(\[[\s\S]*?\]);\s*(?:const|var|let|\/\/)/);
  if (!match) throw new Error('Could not find propertiesData in page HTML');

  let all;
  try { all = JSON.parse(match[1]); }
  catch { throw new Error('Failed to parse propertiesData JSON'); }

  console.log(`Tamarack: ${all.length} total units found`);

  // Filter Ottawa only
  const ottawa = all.filter(p => p.region === 'Ottawa' || p.region === 'Ottawa, ON');
  console.log(`Tamarack: ${ottawa.length} Ottawa units`);

  // Group by community
  const byCommunity = {};
  for (const p of ottawa) {
    const name = p.community;
    if (!COMMUNITY_META[name]) {
      console.log(`  Skipping unknown community: ${name}`);
      continue;
    }
    if (!byCommunity[name]) byCommunity[name] = [];
    byCommunity[name].push(p);
  }

  const builds = [];
  const now = new Date().toISOString();

  for (const [commName, units] of Object.entries(byCommunity)) {
    const meta   = COMMUNITY_META[commName];
    const id     = `tamarack-${slugify(commName)}`;
    const addr   = COMMUNITY_ADDRESS[commName] || `${commName}, Ottawa, ON`;

    console.log(`\nTamarack: processing ${commName} (${units.length} units)`);

    // Geocode
    let lat = null, lng = null;
    // Try lat/lng from a unit first
    const withGeo = units.find(u => u.lat && u.lng);
    if (withGeo) { lat = parseFloat(withGeo.lat); lng = parseFloat(withGeo.lng); }
    if (!lat) {
      const geo = await geocode(addr);
      if (geo) { lat = geo.lat; lng = geo.lng; }
      await sleep(1100);
    }

    // Group by model name — deduplicate same model across statuses
    const modelMap = {};
    for (const u of units) {
      const mName = (u.home_model || '').trim();
      if (!mName) continue;
      if (!modelMap[mName]) modelMap[mName] = [];
      modelMap[mName].push(u);
    }

    // Build model list — lowest price per model, one image per model
    const models = [];
    for (const [mName, mUnits] of Object.entries(modelMap)) {
      const prices    = mUnits.map(u => parsePrice(u.sale_price || u.price)).filter(Boolean);
      const priceFrom = prices.length ? Math.min(...prices) : null;
      const sample    = mUnits[0];
      const statuses  = [...new Set(mUnits.map(u => u.construction_status).filter(Boolean))];
      const statusLabel = statuses.includes('move-in-ready') ? 'Move-In Ready'
        : statuses.includes('under-construction') ? 'Under Construction'
        : statuses.includes('new-construction')   ? 'New Construction'
        : statuses[0] || '';

      // Download image
      let localImageUrl = null;
      if (sample.image_url) {
        const ext   = sample.image_url.split('?')[0].split('.').pop() || 'jpg';
        const fname = `${slugify(commName)}-${slugify(mName)}.${ext}`;
        const dest  = `${IMAGES_DIR}/${fname}`;
        await downloadImage(sample.image_url, dest);
        localImageUrl = `/images/tamarack/${fname}`;
        await sleep(200);
      }

      const hType = (sample.home_type || '').toLowerCase();
      const type  = hType.includes('town') ? 'Townhomes' : 'Single Family';

      models.push({
        name:               mName,
        type,
        beds:               sample.beds   ? parseInt(sample.beds)   : null,
        baths:              sample.baths  ? parseFloat(sample.baths) : null,
        sqft:               sample.sqft   ? parseInt(sample.sqft)   : null,
        priceFrom,
        priceFromFormatted: fmtPrice(priceFrom),
        status:             statusLabel,
        localImageUrl,
        modelUrl:           sample.url || null,
        unitCount:          mUnits.length,
      });
    }

    // Community priceFrom = lowest across all models
    const allPrices    = models.map(m => m.priceFrom).filter(Boolean);
    const communityPrice = allPrices.length ? Math.min(...allPrices) : null;

    // Detect home types
    const homeTypes = [...new Set(models.map(m => m.type))];

    // Feature sheets
    const featureSheets = [];
    if (models.some(m => m.type === 'Townhomes')) {
      featureSheets.push({ name: 'Tamarack - Townhomes - Feature Sheet', localUrl: FEAT_TOWNS });
    }
    if (models.some(m => m.type === 'Single Family')) {
      featureSheets.push({ name: 'Tamarack - Singles - Feature Sheet', localUrl: FEAT_SINGLES });
    }

    // Price report
    const reportDate = now.slice(0, 10);
    const reportPath = `${REPORTS_DIR}/${slugify(commName)}-${reportDate}.json`;
    const report = {
      community:  commName,
      builder:    'Tamarack Homes',
      date:       now,
      models: models.map(m => ({
        name:    m.name,
        type:    m.type,
        status:  m.status,
        beds:    m.beds,
        baths:   m.baths,
        sqft:    m.sqft,
        price:   m.priceFromFormatted,
        unitCount: m.unitCount,
      })),
    };
    writeReportOnce(reportPath, report);
    console.log(`  → ${models.length} models, from ${fmtPrice(communityPrice)}, report saved`);

    builds.push({
      id,
      name:               commName,
      builder:            'Tamarack Homes',
      community:          meta.community,
      address:            addr,
      lat,
      lng,
      homeTypes,
      type:               homeTypes.length === 1 ? (homeTypes[0] === 'Townhomes' ? 'townhouse' : 'single-family') : 'mixed',
      models,
      typePrices:         [],
      priceFrom:          communityPrice,
      priceFromFormatted: fmtPrice(communityPrice),
      taxIncluded:        false,
      featureSheets,
      includedFeatures:   [],
      status:             'selling',
      completionYear:     null,
      description:        `${commName} by Tamarack Homes in ${meta.community}, Ottawa.`,
      sourceUrl:          `https://tamarackhomes.com/ottawa/${slugify(commName)}/`,
      sourceName:         'tamarackhomes.com',
      scrapedAt:          now,
    });
  }

  return builds;
}
