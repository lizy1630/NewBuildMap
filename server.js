/**
 * Simple dev/prod server:
 *   - Serves public/ as static files
 *   - POST /api/leads  → appends lead to leads.json
 *
 * Start: node server.js
 */

import http     from 'http';
import fs       from 'fs';
import path     from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const LEADS_FILE = path.join(__dirname, 'leads.json');
const PORT       = process.env.PORT || 8080;

// ── MIME types ──────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.ttf':  'font/ttf',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

// ── Ensure leads.json exists ─────────────────────────────────────────────────
if (!fs.existsSync(LEADS_FILE)) {
  fs.writeFileSync(LEADS_FILE, '[]', 'utf-8');
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS headers (useful during dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── POST /api/leads ────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/leads') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const lead = JSON.parse(body);
        // Ensure required fields
        const entry = {
          name:      lead.name      || '—',
          email:     lead.email     || '—',
          phone:     lead.phone     || '—',
          community: lead.community || '—',
          type:      lead.type      || 'unknown',
          ts:        lead.ts        || new Date().toISOString(),
          // human-readable local time
          localTime: new Date(lead.ts || Date.now())
            .toLocaleString('en-CA', { timeZone: 'America/Toronto' }),
        };

        const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
        leads.push(entry);
        fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8');

        console.log(`[lead] ${entry.type} — ${entry.name} <${entry.email}> · ${entry.community}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('[lead] parse error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let urlPath = req.url.split('?')[0]; // strip query string
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, urlPath);

  // Security: prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // SPA fallback — serve index.html for unknown routes
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(d2);
        });
      } else {
        res.writeHead(500); res.end('Server error');
      }
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Ottawa New Build Map`);
  console.log(`  ─────────────────────`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Leads log: ${LEADS_FILE}\n`);
});
