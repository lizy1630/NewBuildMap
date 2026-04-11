/**
 * Compare module — side-by-side builder model comparison.
 *
 * State lives here. app.js calls setCompareA/setCompareB.
 * URL hash: #compare=build-a-id,build-b-id
 */

import { openSidebar, switchTab } from './components/sidebar.js';

let _buildA = null;
let _buildB = null;
let _allBuilds = [];
let _isSelectingB = false;
let _onSelectingBChange = null;

export function initCompare(builds, { onSelectingBChange }) {
  _allBuilds = builds;
  _onSelectingBChange = onSelectingBChange;

  // Restore from URL hash
  const hash = window.location.hash;
  const m = hash.match(/compare=([^,]+),([^&]+)/);
  if (m) {
    const a = builds.find((b) => b.id === m[1]);
    const b = builds.find((b) => b.id === m[2]);
    if (a && b) {
      _buildA = a;
      _buildB = b;
    }
  }
}

export function startCompare(buildA) {
  _buildA = buildA;
  _buildB = null;
  _isSelectingB = true;
  document.body.classList.add('compare-mode');
  if (_onSelectingBChange) _onSelectingBChange(true);
  openSidebar();
  switchTab('compare');
  renderCompare();
}

export function setCompareB(buildB) {
  if (!_isSelectingB) return;
  _buildB = buildB;
  _isSelectingB = false;
  document.body.classList.remove('compare-mode');
  if (_onSelectingBChange) _onSelectingBChange(false);
  updateHash();
  renderCompare();
}

export function isSelectingB() { return _isSelectingB; }

export function cancelCompare() {
  _isSelectingB = false;
  document.body.classList.remove('compare-mode');
  if (_onSelectingBChange) _onSelectingBChange(false);
  renderCompare();
}

export function clearCompare() {
  _buildA = null;
  _buildB = null;
  _isSelectingB = false;
  document.body.classList.remove('compare-mode');
  window.location.hash = '';
  if (_onSelectingBChange) _onSelectingBChange(false);
  renderCompare();
}

export function renderCompare() {
  const panel = document.getElementById('tab-compare');

  if (!_buildA) {
    panel.innerHTML = `
      <div class="compare-placeholder">
        <div class="big-icon">⇌</div>
        <p>Open a community from the map, then click <strong>Compare</strong> to start a side-by-side comparison.</p>
      </div>`;
    return;
  }

  if (_isSelectingB) {
    panel.innerHTML = `
      <div class="compare-selecting-banner">
        <span>⊕</span>
        Now click a second community on the map to compare
      </div>
      <div style="padding:14px 20px">
        <div style="font-size:12px;font-weight:600;margin-bottom:4px">${esc(_buildA.name)}</div>
        <div style="font-size:11px;color:var(--text-3)">${esc(_buildA.builder)}</div>
      </div>
      <div style="padding:0 20px">
        <button class="btn btn-ghost" id="btn-cancel-compare" style="width:100%">Cancel</button>
      </div>`;
    document.getElementById('btn-cancel-compare')?.addEventListener('click', cancelCompare);
    return;
  }

  if (!_buildB) {
    panel.innerHTML = `
      <div class="compare-placeholder">
        <div class="big-icon">⇌</div>
        <p>Select a community to compare from the map, or click <strong>Compare</strong> from a detail panel.</p>
      </div>`;
    return;
  }

  const a = _buildA;
  const b = _buildB;

  const rows = buildCompareRows(a, b);

  panel.innerHTML = `
    <div class="compare-grid">
      <div class="compare-col-header" style="border-right:1px solid var(--border)">
        <div class="compare-builder-tag">${esc(a.builder)}</div>
        <div class="compare-community-name">${esc(a.name)}</div>
      </div>
      <div class="compare-col-header">
        <div class="compare-builder-tag">${esc(b.builder)}</div>
        <div class="compare-community-name">${esc(b.name)}</div>
      </div>
      ${rows}
    </div>
    <div style="padding:14px 20px;display:flex;gap:8px">
      <a href="${esc(a.sourceUrl)}" target="_blank" rel="noopener" class="btn btn-secondary" style="flex:1">View A ↗</a>
      <a href="${esc(b.sourceUrl)}" target="_blank" rel="noopener" class="btn btn-secondary" style="flex:1">View B ↗</a>
    </div>
    <div style="padding:0 20px 14px">
      <button class="btn btn-ghost" id="btn-clear-compare" style="width:100%">✕ Clear Comparison</button>
    </div>
  `;

  document.getElementById('btn-clear-compare')?.addEventListener('click', clearCompare);
}

function buildCompareRows(a, b) {
  const sections = [];

  // Pricing
  sections.push(sectionHeader('Pricing'));
  sections.push(metricRow('From Price', a.priceFrom, b.priceFrom, 'price', 'lower'));
  sections.push(metricRow('Min Model', minModelPrice(a), minModelPrice(b), 'price', 'lower'));
  sections.push(metricRow('Max Model', maxModelPrice(a), maxModelPrice(b), 'price', 'neutral'));

  // Details
  sections.push(sectionHeader('Community'));
  sections.push(textRow('Community', a.community, b.community));
  sections.push(textRow('Status', fmtStatus(a.status), fmtStatus(b.status)));
  sections.push(textRow('Type', fmtType(a.type), fmtType(b.type)));
  sections.push(metricRow('Completion', a.completionYear, b.completionYear, 'year', 'lower'));

  // Models comparison
  if ((a.models?.length ?? 0) > 0 || (b.models?.length ?? 0) > 0) {
    sections.push(sectionHeader('Floor Plans'));
    sections.push(metricRow('# Models', a.models?.length ?? 0, b.models?.length ?? 0, 'count', 'higher'));
    sections.push(metricRow('Max Sqft', maxSqft(a), maxSqft(b), 'sqft', 'higher'));
    sections.push(metricRow('Max Beds', maxBeds(a), maxBeds(b), 'count', 'higher'));
  }

  return sections.join('');
}

function sectionHeader(label) {
  return `<div class="compare-divider" style="grid-column:1/-1;margin:8px 0 0"></div>
    <div style="grid-column:1/-1;padding:6px 8px 2px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3)">${label}</div>`;
}

function metricRow(label, valA, valB, format, winner) {
  const aStr = fmt(valA, format);
  const bStr = fmt(valB, format);
  let aClass = '', bClass = '';

  if (valA != null && valB != null && valA !== valB) {
    if (winner === 'lower') {
      aClass = valA < valB ? 'compare-value-better' : 'compare-value-worse';
      bClass = valB < valA ? 'compare-value-better' : 'compare-value-worse';
    } else if (winner === 'higher') {
      aClass = valA > valB ? 'compare-value-better' : 'compare-value-worse';
      bClass = valB > valA ? 'compare-value-better' : 'compare-value-worse';
    }
  }

  return `
    <div class="compare-cell ${aClass} compare-value-mono" style="border-right:1px solid var(--border)">${aStr}</div>
    <div class="compare-cell ${bClass} compare-value-mono">${bStr}</div>`;
}

function textRow(label, valA, valB) {
  return `
    <div class="compare-cell" style="border-right:1px solid var(--border)">${esc(valA || '—')}</div>
    <div class="compare-cell">${esc(valB || '—')}</div>`;
}

function fmt(val, format) {
  if (val == null) return '—';
  if (format === 'price') return '$' + Number(val).toLocaleString('en-CA');
  if (format === 'sqft') return Number(val).toLocaleString() + ' sqft';
  return String(val);
}

function minModelPrice(b) {
  if (!b.models?.length) return b.priceFrom;
  return Math.min(...b.models.map((m) => m.priceFrom).filter(Boolean));
}
function maxModelPrice(b) {
  if (!b.models?.length) return b.priceFrom;
  return Math.max(...b.models.map((m) => m.priceFrom).filter(Boolean));
}
function maxSqft(b) {
  if (!b.models?.length) return null;
  return Math.max(...b.models.map((m) => m.sqft).filter(Boolean));
}
function maxBeds(b) {
  if (!b.models?.length) return null;
  return Math.max(...b.models.map((m) => m.beds).filter(Boolean));
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtStatus(s) {
  const map = { selling: 'Selling', limited: 'Limited', 'sold-out': 'Sold Out', upcoming: 'Upcoming', construction: 'Under Const.' };
  return map[s] || s || '';
}

function fmtType(t) {
  const map = { 'single-family': 'Single Family', townhouse: 'Townhouse', 'semi-detached': 'Semi', condo: 'Condo', mixed: 'Mixed' };
  return map[t] || t || '';
}

function updateHash() {
  if (_buildA && _buildB) {
    window.location.hash = `compare=${_buildA.id},${_buildB.id}`;
  }
}
