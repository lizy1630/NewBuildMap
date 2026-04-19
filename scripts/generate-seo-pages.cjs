#!/usr/bin/env node
/**
 * Generates static SEO landing pages for each Ottawa area.
 * Run: node scripts/generate-seo-pages.js
 * Output: public/{area}/index.html for each area, + updates sitemap.xml
 */

const fs   = require('fs');
const path = require('path');

const DATA_FILE    = path.join(__dirname, '../public/data/builds.json');
const PUBLIC_DIR   = path.join(__dirname, '../public');
const SITEMAP_FILE = path.join(PUBLIC_DIR, 'sitemap.xml');

const { builds } = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

// Must match AREA_MAP in filters.js
const AREA_MAP = {
  'Alta Vista / East': 'Ottawa Urban', 'Rockcliffe Park': 'Ottawa Urban',
  'Nepean': 'Ottawa Urban', 'Ottawa West': 'Ottawa Urban',
  'Ottawa East': 'Ottawa Urban', 'Ottawa South': 'Ottawa Urban',
  'Ottawa': 'Ottawa Urban', 'Centretown': 'Ottawa Urban',
  'Alta Vista': 'Ottawa Urban',
  'Barrhaven': 'Barrhaven', 'Riverside South': 'Barrhaven',
  'Half Moon Bay': 'Barrhaven', 'Stonebridge': 'Barrhaven',
  'Kanata': 'Kanata', 'Kanata North': 'Kanata', 'Kanata South': 'Kanata',
  'Kanata Lakes': 'Kanata', 'Stittsville / Kanata': 'Kanata',
  'Orléans': 'Orléans', 'Orleans': 'Orléans',
  'Stittsville': 'Stittsville',
  'Richmond': 'Richmond', 'Richmond Village': 'Richmond', 'Kemptville': 'Richmond',
  'Findlay Creek': 'Findlay Creek', 'Leitrim / Findlay Creek': 'Findlay Creek',
  'Leitrim': 'Findlay Creek',
  'Manotick': 'Manotick',
  "Cowan's Grove": 'Richmond',
};

const AREA_SLUGS = {
  'Ottawa Urban':  'ottawa',
  'Barrhaven':     'barrhaven',
  'Kanata':        'kanata',
  'Orléans':       'orleans',
  'Stittsville':   'stittsville',
  'Richmond':      'richmond',
  'Findlay Creek': 'findlay-creek',
  'Manotick':      'manotick',
};

const AREA_DESCS = {
  'Ottawa Urban':  'Ottawa (Urban)',
  'Barrhaven':     'Barrhaven',
  'Kanata':        'Kanata',
  'Orléans':       'Orléans',
  'Stittsville':   'Stittsville',
  'Richmond':      'Richmond & Kemptville',
  'Findlay Creek': 'Findlay Creek & Leitrim',
  'Manotick':      'Manotick',
};

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatPrice(n) {
  return '$' + n.toLocaleString('en-CA');
}

function minPrice(build) {
  const prices = (build.models || []).map(m => m.priceFrom).filter(Boolean);
  return prices.length ? Math.min(...prices) : null;
}

function homeTypeLabel(types) {
  if (!types || !types.length) return 'New Homes';
  const set = new Set(types.map(t => {
    if (['Single Family','Bungalows','Singles & Bungalows'].some(k => t.includes(k.split(' ')[0]))) return 'Single Family';
    if (['Condo','Flat','Flats','Condos'].some(k => t.includes(k))) return 'Condo';
    return 'Townhome';
  }));
  return [...set].join(', ');
}

const today = new Date().toISOString().slice(0, 10);
const year  = new Date().getFullYear();

const sitemapUrls = [
  { loc: 'https://newbuildmap.ca/', priority: '1.0' },
];

for (const [areaName, slug] of Object.entries(AREA_SLUGS)) {
  const areaBuilds = builds.filter(b => AREA_MAP[b.community] === areaName);
  if (!areaBuilds.length) continue;

  const label    = AREA_DESCS[areaName];
  const count    = areaBuilds.length;
  const builders = [...new Set(areaBuilds.map(b => b.builder))].sort();
  const filterParam = encodeURIComponent(areaName);

  // Build community rows
  const rows = areaBuilds.map(b => {
    const price = minPrice(b);
    const types = homeTypeLabel(b.homeTypes);
    return `
      <tr>
        <td><strong>${esc(b.name)}</strong></td>
        <td>${esc(b.builder)}</td>
        <td>${esc(b.community)}</td>
        <td>${esc(types)}</td>
        <td>${price ? formatPrice(price) : 'Contact builder'}</td>
      </tr>`;
  }).join('');

  // JSON-LD ItemList
  const listItems = areaBuilds.map((b, i) => {
    const price = minPrice(b);
    return {
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'RealEstateListing',
        name: `${b.name} by ${b.builder}`,
        description: `${homeTypeLabel(b.homeTypes)} in ${b.community}, Ottawa${price ? ` from ${formatPrice(price)}` : ''}`,
        url: `https://newbuildmap.ca/?area=${filterParam}`,
        address: {
          '@type': 'PostalAddress',
          addressLocality: b.community,
          addressRegion: 'ON',
          addressCountry: 'CA',
        },
        ...(price ? { offers: { '@type': 'Offer', priceCurrency: 'CAD', price: price, availability: 'https://schema.org/InStock' } } : {}),
      },
    };
  });

  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `New Build Homes in ${label}, Ottawa`,
    description: `${count} new construction communities in ${label}, Ottawa from builders including ${builders.join(', ')}.`,
    url: `https://newbuildmap.ca/${slug}/`,
    numberOfItems: count,
    itemListElement: listItems,
  }, null, 2);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New Builds in ${label}, Ottawa ${year} | Ottawa New Builds Map</title>
  <meta name="description" content="Browse ${count} new construction communities in ${label}, Ottawa. Find new homes, townhomes, and condos from ${builders.slice(0,3).join(', ')} and more. Prices and floor plans updated ${today}." />
  <link rel="canonical" href="https://newbuildmap.ca/${slug}/" />

  <meta property="og:type"        content="website" />
  <meta property="og:url"         content="https://newbuildmap.ca/${slug}/" />
  <meta property="og:title"       content="New Builds in ${esc(label)}, Ottawa ${year}" />
  <meta property="og:description" content="${count} new construction communities in ${esc(label)} from ${esc(builders.slice(0,3).join(', '))} and more." />
  <meta property="og:image"       content="https://newbuildmap.ca/images/og-preview.png" />

  <script type="application/ld+json">${schema}</script>

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f8; color: #111; font-size: 15px; line-height: 1.6; }
    .topbar { background: #fff; border-bottom: 1px solid #ddd; padding: 12px 20px; display: flex; align-items: center; gap: 12px; }
    .topbar a { color: #0099cc; text-decoration: none; font-weight: 600; font-size: 14px; }
    .topbar a:hover { text-decoration: underline; }
    .breadcrumb { font-size: 13px; color: #666; }
    .hero { background: #111; color: #fff; padding: 40px 20px 36px; }
    .hero h1 { font-size: clamp(22px, 4vw, 34px); font-weight: 700; margin-bottom: 10px; }
    .hero p { color: #aaa; font-size: 15px; max-width: 600px; margin-bottom: 20px; }
    .cta-btn { display: inline-block; background: #0099cc; color: #fff; padding: 12px 22px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px; }
    .cta-btn:hover { background: #007aaa; }
    .container { max-width: 960px; margin: 0 auto; padding: 32px 20px; }
    h2 { font-size: 20px; font-weight: 700; margin-bottom: 16px; color: #111; }
    .builders { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 28px; }
    .builder-badge { background: #fff; border: 1px solid #ddd; border-radius: 20px; padding: 5px 14px; font-size: 13px; font-weight: 500; color: #333; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 6px rgba(0,0,0,0.07); }
    th { background: #111; color: #fff; padding: 11px 14px; text-align: left; font-size: 13px; font-weight: 600; }
    td { padding: 11px 14px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f9f9fc; }
    .footer { background: #fff; border-top: 1px solid #ddd; padding: 24px 20px; text-align: center; font-size: 13px; color: #888; margin-top: 40px; }
    .footer a { color: #0099cc; text-decoration: none; }
    .area-links { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 14px; }
    .area-links a { font-size: 13px; color: #0099cc; }
    @media (max-width: 600px) { th:nth-child(3), td:nth-child(3), th:nth-child(5), td:nth-child(5) { display: none; } }
  </style>
</head>
<body>

<div class="topbar">
  <a href="https://newbuildmap.ca/">&#8592; Ottawa New Builds Map</a>
  <span class="breadcrumb">/ ${esc(label)}</span>
</div>

<div class="hero">
  <h1>New Builds in ${esc(label)}, Ottawa</h1>
  <p>${count} active new construction communities from ${builders.length} builder${builders.length > 1 ? 's' : ''}. Prices and availability updated ${today}.</p>
  <a class="cta-btn" href="https://newbuildmap.ca/?area=${filterParam}">View on Map &#8594;</a>
</div>

<div class="container">
  <h2>Builders Active in ${esc(label)}</h2>
  <div class="builders">
    ${builders.map(b => `<span class="builder-badge">${esc(b)}</span>`).join('\n    ')}
  </div>

  <h2>${count} New Build Communities</h2>
  <table>
    <thead>
      <tr>
        <th>Community</th>
        <th>Builder</th>
        <th>Neighbourhood</th>
        <th>Home Types</th>
        <th>Starting From</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>
</div>

<div class="footer">
  <p>&copy; ${year} <a href="https://newbuildmap.ca/">Ottawa New Builds Map</a> &mdash; Updated ${today}</p>
  <div class="area-links">
    <strong>Browse by area:</strong>
    <a href="/barrhaven/">Barrhaven</a>
    <a href="/kanata/">Kanata</a>
    <a href="/orleans/">Orléans</a>
    <a href="/stittsville/">Stittsville</a>
    <a href="/richmond/">Richmond</a>
    <a href="/findlay-creek/">Findlay Creek</a>
    <a href="/manotick/">Manotick</a>
    <a href="/ottawa/">Ottawa Urban</a>
  </div>
</div>

</body>
</html>`;

  const dir = path.join(PUBLIC_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
  console.log(`✓ Generated /${slug}/ (${count} builds)`);

  sitemapUrls.push({ loc: `https://newbuildmap.ca/${slug}/`, priority: '0.8' });
}

// Update sitemap
const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

fs.writeFileSync(SITEMAP_FILE, sitemapXml, 'utf8');
console.log(`✓ Updated sitemap.xml (${sitemapUrls.length} URLs)`);
