/**
 * Sidebar component — manages open/close, tab switching, and rendering detail view.
 */
import { openLeadModal, requestInfo, hasRequested, isUnlocked } from '../lead.js';
import { getFilters, clearFilter, modelMatchesFilters, getArea } from './filters.js';

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

  // Delegated: tax-free checkbox anywhere in sidebar
  sidebarContent.addEventListener('change', (e) => {
    if (e.target.id === 'chk-tax-free' && _currentBuild) {
      _taxFree = e.target.checked;
      const priceRowsEl = tabPanels.detail.querySelector('#detail-price-rows');
      if (!priceRowsEl) return;
      const priceChange = getPriceChange(_currentBuild);
      priceRowsEl.innerHTML = `
        ${priceRows(_currentBuild)}
        ${priceChange ? `<div class="price-change-note ${priceChange.dir}">
          ${priceChange.dir === 'up' ? '▲' : '▼'} ${fmtPrice(Math.abs(priceChange.delta))} since ${priceChange.since}
        </div>` : ''}
        <label class="tax-free-toggle">
          <input type="checkbox" id="chk-tax-free"${_taxFree ? ' checked' : ''}> Show tax-free price
        </label>`;
    }
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

// ── builder color / click injection ──
let _builderColorFn = null;
let _builderClickFn = null;
export function setBuilderColorFn(fn) { _builderColorFn = fn; }
export function setBuilderClickFn(fn) { _builderClickFn = fn; }

// ── model filter / sort state ──
let _currentBuild = null;
let _activeCategory = 'All';
let _sortBy = 'sqft'; // 'sqft' | 'price'
let _taxFree = false;  // show tax-free price for tax-included builders

/** Tax-free formula: builder price includes HST → back-calculate pre-tax */
function taxFreePrice(p) {
  if (!p) return null;
  return Math.round((p + 24000) / 1.13);
}

function displayPrice(p, formatted) {
  if (!_taxFree) return formatted || fmtPrice(p);
  const tf = taxFreePrice(p);
  return tf ? fmtPrice(tf) : (formatted || fmtPrice(p));
}

// ─────────────────────────────────────────────
// Community-level starting from price rows
// If typePrices is available, show one row per type.
// Otherwise fall back to single community-level price.
// ─────────────────────────────────────────────
function hasNoPrice(val) {
  if (!val) return true;
  const s = String(val).toLowerCase().trim();
  return s === '' || s.includes('not available') || s === 'n/a' || s === '—';
}

function priceRows(build) {
  if (build.typePrices && build.typePrices.length) {
    return build.typePrices.map(t => {
      const noPrice = hasNoPrice(t.priceFrom) && hasNoPrice(t.priceFromFormatted);
      return `
      <div class="price-row">
        <span class="price-row-label">${esc(t.type)}</span>
        ${noPrice
          ? `<span class="price-row-value"><span class="price-from-label">From </span><span class="price-na">UNAVAILABLE</span></span>`
          : `<span class="price-row-value"><span class="price-from-label">From </span>${esc(displayPrice(t.priceFrom, t.priceFromFormatted))}</span>`
        }
      </div>`;
    }).join('');
  }
  const noPrice = hasNoPrice(build.priceFrom) && hasNoPrice(build.priceFromFormatted);
  if (noPrice) return `
  <div class="price-row">
    <span class="price-row-label">From</span>
    <span class="price-row-value"><span class="price-na">UNAVAILABLE</span></span>
  </div>`;
  return `<div class="price-row">
    <span class="price-row-label">From</span>
    <span class="price-row-value">${esc(displayPrice(build.priceFrom, build.priceFromFormatted))}</span>
  </div>`;
}

// ─────────────────────────────────────────────
// Active filter tags strip
// ─────────────────────────────────────────────
function activeFilterTagsHTML() {
  const f = getFilters();
  const tags = [];
  if (f.community) tags.push({ key: 'community', label: `📍 ${f.community}` });
  if (f.homeType)  tags.push({ key: 'homeType',  label: `🏠 ${f.homeType}` });
  if (f.beds)      tags.push({ key: 'beds',      label: `🛏 ${f.beds.replace('=', '')} bed${f.beds.startsWith('=') ? '' : '+'}` });
  if (f.baths)     tags.push({ key: 'baths',     label: `🚿 ${f.baths.replace('=', '')} bath${f.baths.startsWith('=') ? '' : '+'}` });
  if (f.sqft)      tags.push({ key: 'sqft',      label: `📐 ${f.sqft.startsWith('<') ? '< ' + f.sqft.slice(1) : f.sqft + '+'} sqft` });
  if (f.lot)       tags.push({ key: 'lot',       label: `📏 ${f.lot}ft+ lot` });
  if (!tags.length) return '';
  return `<div class="active-filter-tags" id="active-filter-tags">
    ${tags.map(t => `<button class="filter-tag" data-filter-key="${esc(t.key)}">${esc(t.label)} ×</button>`).join('')}
  </div>`;
}

// ─────────────────────────────────────────────
// Helper — only sheets with a real URL
// ─────────────────────────────────────────────
function getValidSheets(build) {
  if (!build.featureSheets) return [];
  return build.featureSheets.filter(fs => {
    const href = fs.localUrl || fs.url;
    return href && typeof href === 'string' && href.trim() !== '';
  });
}

// ─────────────────────────────────────────────
// Feature sheets section
// ─────────────────────────────────────────────
function featureSheetsHTML(build) {
  const sheets = getValidSheets(build);
  if (!sheets.length) return '';
  const links = sheets.map(fs => {
    const href = fs.localUrl || fs.url;
    const label = (fs.name || href).replace(/^[^-]+-\s*[^-]+-\s*/, ''); // strip "Caivan - Fox Run - "
    return `<a class="feature-sheet-link" href="${esc(href)}" target="_blank" rel="noopener">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2h5l3 3v7H2V2z" stroke="currentColor" stroke-width="1" fill="none"/><path d="M7 2v3h3" stroke="currentColor" stroke-width="1"/><path d="M4 7h4M4 9h3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>
      ${esc(label)}
    </a>`;
  }).join('');
  return `<div class="feature-sheets-section">
    <div class="feature-sheets-label">Features &amp; Finishes</div>
    <div class="feature-sheets-links">${links}</div>
  </div>`;
}

// ─────────────────────────────────────────────
// Request section
// Hidden for communities that already have valid price sheets.
// Shows "Requested ✓" if the user already requested this community.
// ─────────────────────────────────────────────
function requestInfoHTML(build) {
  const sent = hasRequested(build.id);
  return `
  <div class="request-info-section" id="request-info-section">
    ${sent
      ? `<button class="btn-request-sent" disabled>Requested ✓</button>`
      : `<button class="btn-request-info" id="btn-request-info">Request</button>`
    }
  </div>`;
}

// ─────────────────────────────────────────────
// renderDetail — main entry point
// ─────────────────────────────────────────────
export function renderDetail(build) {
  const panel = tabPanels.detail;
  _currentBuild = build;
  _activeCategory = 'All';
  _sortBy = 'sqft';
  _taxFree = false;

  if (!build) {
    panel.innerHTML = '<div style="padding:24px 20px;color:var(--text-3);font-size:12px">Select a marker on the map.</div>';
    return;
  }

  const priceChange = getPriceChange(build);
  const categories = getCategories(build.models || []);

  const builderColor = _builderColorFn ? _builderColorFn(build.builder) : '#9090b0';

  panel.innerHTML = `
    <div class="detail-header">
      <div class="detail-name">${esc(build.name)}</div>
      <div class="detail-location">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M6 1a3.5 3.5 0 0 1 3.5 3.5C9.5 8 6 11 6 11S2.5 8 2.5 4.5A3.5 3.5 0 0 1 6 1z" stroke="currentColor" stroke-width="1" fill="none"/><circle cx="6" cy="4.5" r="1" fill="currentColor"/></svg>
        ${esc(build.community)}, Ottawa
      </div>
      <button class="detail-builder-btn" data-builder="${esc(build.builder)}" style="color:${builderColor};border-color:${builderColor}20;background:${builderColor}12">
        ${esc(build.builder)}
      </button>
      ${(() => {
        const statuses = build.statuses || (build.status ? [build.status] : []);
        return statuses.map(s => {
          if (s === 'sold-out')    return `<span class="badge badge-sold-out" style="display:inline-block;margin-top:6px">Sold Out</span>`;
          if (s === 'coming-soon') return `<span class="badge badge-upcoming" style="display:inline-block;margin-top:6px">Coming Soon — Phase 5</span>`;
          if (s === 'upcoming')    return `<span class="badge badge-upcoming" style="display:inline-block;margin-top:6px">Coming Soon</span>`;
          return '';
        }).join(' ');
      })()}
      ${build.description ? `<div class="detail-description">${esc(build.description)}</div>` : ''}
    </div>

    ${activeFilterTagsHTML()}

    <div class="detail-price-rows" id="detail-price-rows">
      ${priceRows(build)}
      ${priceChange ? `<div class="price-change-note ${priceChange.dir}">
        ${priceChange.dir === 'up' ? '▲' : '▼'} ${fmtPrice(Math.abs(priceChange.delta))} since ${priceChange.since}
      </div>` : ''}
      ${build.taxIncluded ? `<label class="tax-free-toggle">
        <input type="checkbox" id="chk-tax-free"> Show tax-free price
      </label>` : ''}
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

    ${featureSheetsHTML(build)}

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

  // Builder name click — same effect as clicking builder in legend
  panel.querySelector('.detail-builder-btn')?.addEventListener('click', () => {
    if (_builderClickFn) _builderClickFn(build.builder);
  });

  // Filter tag × — clear that filter and re-render
  panel.querySelector('#active-filter-tags')?.addEventListener('click', (e) => {
    const tag = e.target.closest('.filter-tag');
    if (tag) {
      clearFilter(tag.dataset.filterKey);
      renderDetail(_currentBuild); // re-render tags + model cards
    }
  });
}

// Re-render sidebar when global filters change (updates tags + model list)
window.addEventListener('filters-changed', () => {
  if (_currentBuild && isSidebarOpen()) {
    // Refresh tags and model cards without full re-render
    const panel = tabPanels.detail;
    const tagsEl = panel.querySelector('#active-filter-tags');
    const newTagsHTML = activeFilterTagsHTML();
    if (tagsEl) tagsEl.outerHTML = newTagsHTML || '';
    else if (newTagsHTML) {
      panel.querySelector('.detail-price-rows')?.insertAdjacentHTML('beforebegin', newTagsHTML);
    }
    renderModelCards();
  }
});

// Re-render prices after unlock
window.addEventListener('lead-unlocked', () => {
  if (_currentBuild) renderDetail(_currentBuild);
});

// Re-render model cards when a request is sent or user registers
window.addEventListener('request-sent', (e) => {
  if (_currentBuild && e.detail?.buildId === _currentBuild.id) {
    renderModelCards();
  }
});

// ─────────────────────────────────────────────
// Model cards
// ─────────────────────────────────────────────

function renderModelCards() {
  const panel = tabPanels.detail;
  const container = panel.querySelector('#model-cards');
  if (!container || !_currentBuild) return;

  let models = [...(_currentBuild.models || [])];

  // Category filter (sidebar tab)
  if (_activeCategory !== 'All') {
    models = models.filter((m) => m.type === _activeCategory);
  }

  // Apply active global model-level filters (beds, baths, sqft, lot)
  const f = getFilters();
  const hasModelFilter = f.beds || f.baths || f.sqft || f.lot;
  if (hasModelFilter) {
    models = models.filter(m => modelMatchesFilters(m, f));
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
    container.innerHTML = `<div style="padding:16px 20px;color:var(--text-3);font-size:12px">No models match the current filters.</div>`;
    return;
  }

  container.innerHTML = models.map((m) => modelCardHTML(m, _currentBuild)).join('');

  // Delegate clicks on per-model request buttons
  container.querySelectorAll('.btn-model-request').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!_currentBuild) return;
      requestInfo({ id: _currentBuild.id, name: _currentBuild.name, community: _currentBuild.community });
    });
  });
}

function modelCardHTML(m, build) {
  const unlocked  = isUnlocked();
  const requested = build ? hasRequested(build.id) : false;

  const hasImage = !!m.localImageUrl;
  const name = m.modelUrl
    ? `<a href="${esc(m.modelUrl)}" target="_blank" rel="noopener" class="model-card-name-link">${esc(m.name)}</a>`
    : `<span class="model-card-name-text">${esc(m.name)}</span>`;

  const specs = [
    m.beds != null ? `<span class="spec-chip">${m.beds} bd</span>` : '',
    m.baths != null ? `<span class="spec-chip">${m.baths} ba</span>` : '',
    m.garages       ? `<span class="spec-chip">${m.garages} gar</span>` : '',
    m.lotWidth      ? `<span class="spec-chip">${m.lotWidth}′ lot</span>` : '',
  ].filter(Boolean).join('');

  const sqftLine = m.sqft ? `<div class="model-card-sqft">${m.sqft.toLocaleString()} sqft</div>` : '';

  // Price row — always show, blurred + Request button if not yet unlocked
  let priceHTML = '';
  const hasPrice = m.priceFrom || m.priceFromFormatted;
  const formatted = hasPrice ? (fmtPrice(m.priceFrom) || esc(m.priceFromFormatted)) : 'UNAVAILABLE';

  if (unlocked) {
    priceHTML = `<div class="model-card-price${hasPrice ? '' : ' price-na'}">${formatted}</div>`;
  } else {
    priceHTML = `
      <div class="model-price-locked">
        <span class="model-price-dollar">$</span><span class="model-price-blur">${hasPrice ? formatted : '888,888'}</span>
        <button class="btn-model-request${requested ? ' btn-model-requested' : ''}">
          ${requested ? 'Requested ✓' : '🔒 Request Price'}
        </button>
      </div>`;
  }

  return `
  <div class="model-card">
    ${hasImage ? `<img class="model-card-img" src="${esc(m.localImageUrl)}" alt="${esc(m.name)}" loading="lazy">` : ''}
    <div class="model-card-body">
      <div class="model-card-header">
        <div class="model-card-name">${name}</div>
      </div>
      ${m.type ? `<div class="model-card-type">${esc(m.type)}</div>` : ''}
      ${sqftLine}
      ${priceHTML}
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
