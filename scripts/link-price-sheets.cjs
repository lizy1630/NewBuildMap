#!/usr/bin/env node
/**
 * Links the latest price sheet PDF to each build in builds.json.
 * Adds `latestPriceSheetUrl: "/data/builder-price-reports/name-date.pdf"` per build.
 * Run after each scrape: node scripts/link-price-sheets.cjs
 */

const fs   = require('fs');
const path = require('path');

const BUILDS_FILE = path.join(__dirname, '../public/data/builds.json');
const DATA_DIR    = path.join(__dirname, '../public/data');

// build ID → { dir, prefix } — prefix matches the start of the PDF filename
const BUILD_PDF_MAP = {
  // Minto
  'minto-harmony':        { dir: 'minto-price-reports',     prefix: 'riversbend-at-harmony' },
  'minto-abbotts-run':    { dir: 'minto-price-reports',     prefix: 'abbott-s-run' },
  'minto-arcadia':        { dir: 'minto-price-reports',     prefix: 'arcadia' },
  'minto-mahogany':       { dir: 'minto-price-reports',     prefix: 'mahogany' },
  'minto-brookline':      { dir: 'minto-price-reports',     prefix: 'brookline' },
  'minto-anthem':         { dir: 'minto-price-reports',     prefix: 'anthem' },
  'minto-avalon':         { dir: 'minto-price-reports',     prefix: 'avalon-vista' },
  // Mattamy
  'mattamy-half-moon-bay':      { dir: 'mattamy-price-reports', prefix: 'half-moon-bay' },
  'mattamy-locale':             { dir: 'mattamy-price-reports', prefix: 'locale' },
  'mattamy-northwoods':         { dir: 'mattamy-price-reports', prefix: 'northwoods' },
  'mattamy-richmond-meadows':   { dir: 'mattamy-price-reports', prefix: 'richmond-meadows' },
  'mattamy-traditions-ii':      { dir: 'mattamy-price-reports', prefix: 'traditions-ii' },
  'mattamy-wateridge-village':  { dir: 'mattamy-price-reports', prefix: 'wateridge-village' },
  // Cardel
  'cardel-ironwood':   { dir: 'cardel-price-reports', prefix: 'ironwood' },
  'cardel-edenwylde':  { dir: 'cardel-price-reports', prefix: 'edenwylde' },
  // Claridge
  'claridge-copperwood-estate': { dir: 'claridge-price-reports', prefix: 'copperwood-estate' },
  'claridge-westwood':          { dir: 'claridge-price-reports', prefix: 'westwood' },
  'claridge-iron-valley':       { dir: 'claridge-price-reports', prefix: 'iron-valley' },
  'claridge-bridlewood-trails': { dir: 'claridge-price-reports', prefix: 'bridlewood-trails' },
  'claridge-watters-pointe':    { dir: 'claridge-price-reports', prefix: 'watter-s-pointe' },
  'claridge-rivers-edge':       { dir: 'claridge-price-reports', prefix: 'river-s-edge' },
  'claridge-lilythorne':        { dir: 'claridge-price-reports', prefix: 'lilythorne' },
  // HN Homes
  'hn-kanata-lakes':     { dir: 'hn-price-reports', prefix: 'kanata-lakes-singles' },
  'hn-riverside-south':  { dir: 'hn-price-reports', prefix: 'riverside-south-singles' },
  // Urbandale
  'urbandale-riverside-south':  { dir: 'urbandale-price-reports', prefix: 'riverside-south' },
  'urbandale-kanata-lakes':     { dir: 'urbandale-price-reports', prefix: 'kanata-lakes' },
  'urbandale-bradley-commons':  { dir: 'urbandale-price-reports', prefix: 'bradley-commons' },
  'urbandale-leitrim-flats':    { dir: 'urbandale-price-reports', prefix: 'leitrim-flats' },
  'urbandale-the-creek':        { dir: 'urbandale-price-reports', prefix: 'the-creek' },
  // Uniform
  'uniform-copperwood-estate': { dir: 'uniform-price-reports', prefix: 'copperwood-estate' },
  // Tamarack (has PDFs too)
  'tamarack-the-meadows':          { dir: 'tamarack-price-reports', prefix: null }, // JSON only
  'tamarack-westwood':             { dir: 'tamarack-price-reports', prefix: null },
  'tamarack-findlay-creek-village':{ dir: 'tamarack-price-reports', prefix: null },
  'tamarack-cardinal-creek-village':{ dir: 'tamarack-price-reports', prefix: null },
  'tamarack-idylea':               { dir: 'tamarack-price-reports', prefix: null },
};

function extractDate(filename) {
  // Extract ISO date like 2026-04-18T15-00-14 from filename
  const m = filename.match(/(\d{4}-\d{2}-\d{2}T[\d-]+)/);
  return m ? m[1].replace(/-(\d{2})-(\d{2})$/, ':$1:$2') : filename;
}

function latestPdf(dir, prefix) {
  if (!prefix) return null;
  const fullDir = path.join(DATA_DIR, dir);
  if (!fs.existsSync(fullDir)) return null;
  const files = fs.readdirSync(fullDir)
    .filter(f => f.endsWith('.pdf') && f.startsWith(prefix))
    .sort((a, b) => extractDate(a).localeCompare(extractDate(b)));
  const latest = files[files.length - 1];
  return latest ? `/data/${dir}/${latest}` : null;
}

const data = JSON.parse(fs.readFileSync(BUILDS_FILE, 'utf8'));

let linked = 0, cleared = 0;
for (const build of data.builds) {
  const mapping = BUILD_PDF_MAP[build.id];
  if (mapping) {
    const url = latestPdf(mapping.dir, mapping.prefix);
    build.latestPriceSheetUrl = url;
    if (url) { console.log(`✓ ${build.id} → ${url}`); linked++; }
    else      { console.log(`– ${build.id} (no PDF found)`); }
  } else {
    build.latestPriceSheetUrl = build.latestPriceSheetUrl || null;
    cleared++;
  }
}

fs.writeFileSync(BUILDS_FILE, JSON.stringify(data, null, 2));
console.log(`\nDone: ${linked} linked, ${cleared} skipped (no mapping)`);
