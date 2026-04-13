/**
 * Sidebar component — manages open/close, tab switching, and rendering detail view.
 */

const sidebar = document.getElementById('sidebar');
const sidebarContent = document.getElementById('sidebar-content');
const closeBtn = document.getElementById('sidebar-close');
const tabs = document.querySelectorAll('.sidebar-tab');
const tabPanels = {
  detail: document.getElementById('tab-detail'),
  compare: document.getElementById('tab-compare'),
  history: document.getElementById('tab-history'),
};

let _activeTab = 'detail';
let _onTabChange = null;

export function initSidebar({ onTabChange }) {
  _onTabChange = onTabChange;
  closeBtn.addEventListener('click', closeSidebar);
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
}

export function openSidebar() { sidebar.classList.add('open'); }
export function closeSidebar() { sidebar.classList.remove('open'); }
export function isSidebarOpen() { return sidebar.classList.contains('open'); }

export function switchTab(name) {
  _activeTab = name;
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  Object.entries(tabPanels).forEach(([k, el]) => {
    el.style.display = k === name ? '' : 'none';
  });
  if (_onTabChange) _onTabChange(name);
}

export function getActiveTab() { return _activeTab; }

// ── price history injection ──
let _priceHistory = null;
export function setPriceHistory(h) { _priceHistory = h; }

// ── model filter / sort state ──
let _currentBuild = null;
let _activeCategory = 'All';
let _sortBy = 'sqft'; // 'sqft' | 'price'

// ─────────────────────────────────────────────
// Build per-category price rows from models
// ─────────────────────────────────────────────
function priceRows(build) {
  const models = build.models || [];

  if (!models.length) {
    return build.priceFromFormatted
      ? `<div class="price-row"><span class="price-row-label">Starting from</span><span class="price-row-value">${build.priceFromFormatted}</span></div>`
      : '';
  }

  // Group by type, find min price per type
  const byType = {};
  for (const m of models) {
    const type = m.type || 'Other';
    if (m.priceFrom != null) {
      if (byType[type] == null || m.priceFrom < byType[type]) {
        byType[type] = m.priceFrom;
      }
    }
  }

  // If no per-type prices, fall back to single priceFrom
  if (!Object.keys(byType).length) {
    return build.priceFromFormatted
      ? `<div class="price-row"><span class="price-row-label">Starting from</span><span class="price-row-value">${build.priceFromFormatted}</span></div>`
      : '';
  }

  // Sort by price ascending
  return Object.entries(byType)
    .sort((a, b) => a[1] - b[1])
    .map(([type, price]) =>
      `<div class="price-row">
        <span class="price-row-label">${esc(type)} starting from</span>
        <span class="price-row-value">${fmtPrice(price)}</span>
      </div>`
    ).join('');
}

// ─────────────────────────────────────────────
// renderDetail — main entry point
// ─────────────────────────────────────────────
export function renderDetail(build) {
  const panel = tabPanels.detail;
  _currentBuild = build;
  _activeCategory = 'All';
  _sortBy = 'sqft';

  if (!build) {
    panel.innerHTML = '<div style="padding:24px 20px;color:var(--text-3);font-size:12px">Select a marker on the map.</div>';
    return;
  }

  const priceChange = getPriceChange(build);
  const categories = getCategories(build.models || []);

  panel.innerHTML = `
    <div class="detail-header">
      <div class="detail-name">${esc(build.name)}</div>
      <div class="detail-builder">${esc(build.builder)}</div>
      <div class="detail-location">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M6 1a3.5 3.5 0 0 1 3.5 3.5C9.5 8 6 11 6 11S2.5 8 2.5 4.5A3.5 3.5 0 0 1 6 1z" stroke="currentColor" stroke-width="1" fill="none"/><circle cx="6" cy="4.5" r="1" fill="currentColor"/></svg>
        ${esc(build.community)}, Ottawa &nbsp;·&nbsp; ${esc(build.address)}
      </div>
      ${build.description ? `<div class="detail-description">${esc(build.description)}</div>` : ''}
    </div>

    <div class="detail-price-rows">
      ${priceRows(build)}
      ${priceChange ? `<div class="price-change-note ${priceChange.dir}">
        ${priceChange.dir === 'up' ? '▲' : '▼'} ${fmtPrice(Math.abs(priceChange.delta))} since ${priceChange.since}
      </div>` : ''}
    </div>

    ${build.models && build.models.length > 0 ? `
    <div class="models-section">
      <div class="models-toolbar">
        <div class="models-toolbar-left">
          <span class="section-title" style="margin:0">Floor Plans</span>
          <span id="models-count" class="models-count">${build.models.length}</span>
        </div>
        <div class="sort-toggle">
          <button class="sort-btn active" data-sort="sqft">Sqft</button>
          <button class="sort-btn" data-sort="price">Price</button>
        </div>
      </div>

      <div class="category-tabs" id="category-tabs">
        ${['All', ...categories].map(c => `
          <button class="cat-btn${c === 'All' ? ' active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>
        `).join('')}
      </div>

      <div id="model-cards"></div>
    </div>` : `
    <div style="padding:16px 20px;color:var(--text-3);font-size:12px">No floor plans listed yet.</div>
    `}

    <div class="detail-actions">
      <button class="btn btn-secondary" id="btn-compare-from-detail">⇌ Compare</button>
      <a href="${esc(build.sourceUrl)}" target="_blank" rel="noopener" class="btn btn-primary">View Listing ↗</a>
    </div>
    <div style="padding:6px 20px 16px;font-size:10px;color:var(--text-3)">
      ${esc(build.sourceName || '')} &nbsp;·&nbsp; Updated ${fmtDate(build.scrapedAt)}
    </div>
  `;

  if (build.models && build.models.length) {
    renderModelCards();
    initModelControls();
  }
}

// ─────────────────────────────────────────────
// Model cards
// ─────────────────────────────────────────────

function renderModelCards() {
  const panel = tabPanels.detail;
  const container = panel.querySelector('#model-cards');
  if (!container || !_currentBuild) return;

  let models = [...(_currentBuild.models || [])];

  // Category filter
  if (_activeCategory !== 'All') {
    models = models.filter((m) => m.type === _activeCategory);
  }

  // Sort
  if (_sortBy === 'sqft') {
    models.sort((a, b) => (a.sqft || 99999) - (b.sqft || 99999));
  } else {
    models.sort((a, b) => (a.priceFrom || 99999999) - (b.priceFrom || 99999999));
  }

  // Update count badge
  const countEl = panel.querySelector('#models-count');
  if (countEl) countEl.textContent = models.length;

  if (!models.length) {
    container.innerHTML = '<div style="padding:16px 20px;color:var(--text-3);font-size:12px">No models in this category.</div>';
    return;
  }

  container.innerHTML = models.map((m) => modelCardHTML(m)).join('');
}

function modelCardHTML(m) {
  const hasImage = !!m.localImageUrl;
  const name = m.modelUrl
    ? `<a href="${esc(m.modelUrl)}" target="_blank" rel="noopener" class="model-card-name-link">${esc(m.name)}</a>`
    : `<span class="model-card-name-text">${esc(m.name)}</span>`;

  const specs = [
    m.beds != null    ? `<span class="spec-chip">${m.beds} bd</span>` : '',
    m.baths != null   ? `<span class="spec-chip">${m.baths} ba</span>` : '',
    m.lotWidth        ? `<span class="spec-chip">${m.lotWidth} ft lot</span>` : '',
    m.garages         ? `<span class="spec-chip">${m.garages} gar</span>` : '',
  ].filter(Boolean).join('');

  const typeLine = [
    m.type || '',
    m.sqft ? m.sqft.toLocaleString() + ' sqft' : '',
  ].filter(Boolean).join(' · ');

  return `
  <div class="model-card">
    ${hasImage ? `<img class="model-card-img" src="${esc(m.localImageUrl)}" alt="${esc(m.name)}" loading="lazy">` : ''}
    <div class="model-card-body">
      <div class="model-card-header">
        <div class="model-card-name">${name}</div>
        <div class="model-card-price">${m.priceFrom ? fmtPrice(m.priceFrom) : '—'}</div>
      </div>
      <div class="model-card-type">${esc(typeLine)}</div>
      <div class="spec-chips">${specs}</div>
    </div>
  </div>`;
}

function getCategories(models) {
  const seen = [];
  for (const m of models) {
    if (m.type && !seen.includes(m.type)) seen.push(m.type);
  }
  return seen.sort();
}

// ─────────────────────────────────────────────
// Event wiring for sort / category
// ─────────────────────────────────────────────

function initModelControls() {
  const panel = tabPanels.detail;

  // Sort buttons
  panel.querySelectorAll('.sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      _sortBy = btn.dataset.sort;
      panel.querySelectorAll('.sort-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderModelCards();
    });
  });

  // Category tabs
  panel.querySelectorAll('.cat-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      _activeCategory = btn.dataset.cat;
      panel.querySelectorAll('.cat-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderModelCards();
    });
  });
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function getPriceChange(build) {
  if (!_priceHistory || !build) return null;
  const snapshots = _priceHistory[build.id];
  if (!snapshots || snapshots.length < 2) return null;
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const delta = last.priceFrom - first.priceFrom;
  if (delta === 0) return null;
  return { delta, dir: delta > 0 ? 'up' : 'down', since: first.date };
}

function getHomeTypes(build) {
  if (build.homeTypes && build.homeTypes.length) return build.homeTypes;
  const t = build.type;
  if (t === 'single-family') return ['Single Family'];
  if (t === 'townhouse') return ['Townhomes'];
  if (t === 'semi-detached') return ['Semi-Detached'];
  if (t === 'condo') return ['Condo'];
  return ['Mixed'];
}

function fmtStatus(s) {
  const map = { selling: 'Selling', limited: 'Limited', 'sold-out': 'Sold Out', upcoming: 'Upcoming', construction: 'Under Construction' };
  return map[s] || (s || '');
}

function fmtPrice(n) {
  if (!n) return '—';
  return '$' + Number(n).toLocaleString('en-CA');
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return iso; }
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
