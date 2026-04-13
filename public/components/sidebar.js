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
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
    });
  });
}

export function openSidebar() {
  sidebar.classList.add('open');
}

export function closeSidebar() {
  sidebar.classList.remove('open');
}

export function isSidebarOpen() {
  return sidebar.classList.contains('open');
}

export function switchTab(name) {
  _activeTab = name;
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  Object.entries(tabPanels).forEach(([k, el]) => {
    el.style.display = k === name ? '' : 'none';
  });
  if (_onTabChange) _onTabChange(name);
}

export function getActiveTab() { return _activeTab; }

export function renderDetail(build) {
  const panel = tabPanels.detail;
  if (!build) {
    panel.innerHTML = '<div class="detail-header"><p style="color:var(--text-3);font-size:12px;padding:8px 0">Select a marker on the map.</p></div>';
    return;
  }

  const statusClass = `badge-${build.status || 'selling'}`;
  const priceChange = getPriceChange(build);

  panel.innerHTML = `
    <div class="detail-header">
      <div class="detail-name">${esc(build.name)}</div>
      <div class="detail-builder">${esc(build.builder)}</div>
      <div class="detail-meta">
        ${build.completionYear ? `<span class="badge badge-year">${build.completionYear}</span>` : ''}
        ${getHomeTypes(build).map(t => `<span class="badge badge-type">${esc(t)}</span>`).join('')}
      </div>
    </div>

    <div class="detail-price">
      <div class="price-label">Starting From</div>
      <div>
        <span class="price-value">${build.priceFromFormatted || '—'}</span>
        ${priceChange ? `<span class="price-change ${priceChange.dir}">
          ${priceChange.dir === 'up' ? '▲' : '▼'} ${fmtPrice(Math.abs(priceChange.delta))} since ${priceChange.since}
        </span>` : ''}
      </div>
    </div>

    <div class="detail-section">
      <div class="section-title">Location</div>
      <div class="detail-community">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 1a3.5 3.5 0 0 1 3.5 3.5C9.5 8 6 11 6 11S2.5 8 2.5 4.5A3.5 3.5 0 0 1 6 1z" stroke="currentColor" stroke-width="1" fill="none"/>
          <circle cx="6" cy="4.5" r="1" fill="currentColor"/>
        </svg>
        ${esc(build.community)}, Ottawa &nbsp;·&nbsp; ${esc(build.address)}
      </div>
    </div>

    ${build.description ? `
    <div class="detail-section">
      <div class="section-title">About</div>
      <div class="detail-description">${esc(build.description)}</div>
    </div>` : ''}

    ${build.models && build.models.length > 0 ? `
    <div class="detail-section">
      <div class="section-title">Floor Plans &amp; Models (${build.models.length})</div>
      <div id="model-filters" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <select id="mf-beds" class="filter-select" style="font-size:11px;padding:3px 6px">
          <option value="">Any Beds</option>
          <option value="2">2+ Beds</option>
          <option value="3">3+ Beds</option>
          <option value="4">4+ Beds</option>
          <option value="5">5+ Beds</option>
        </select>
        <select id="mf-baths" class="filter-select" style="font-size:11px;padding:3px 6px">
          <option value="">Any Baths</option>
          <option value="2">2+ Baths</option>
          <option value="3">3+ Baths</option>
        </select>
        <select id="mf-sqft" class="filter-select" style="font-size:11px;padding:3px 6px">
          <option value="">Any Size</option>
          <option value="500">500+ sqft</option>
          <option value="1000">1,000+ sqft</option>
          <option value="1500">1,500+ sqft</option>
          <option value="2000">2,000+ sqft</option>
          <option value="2500">2,500+ sqft</option>
          <option value="3000">3,000+ sqft</option>
        </select>
        <select id="mf-lot" class="filter-select" style="font-size:11px;padding:3px 6px">
          <option value="">Any Lot</option>
          <option value="31">31ft+</option>
          <option value="35">35ft+</option>
          <option value="44">44ft+</option>
          <option value="50">50ft+</option>
        </select>
      </div>
      <table class="models-table" id="models-table-body">
        <thead>
          <tr>
            <th>Model</th>
            <th>Type</th>
            <th>Bed/Bath</th>
            <th>Sqft</th>
            <th>Lot</th>
            <th style="text-align:right">From</th>
          </tr>
        </thead>
        <tbody>
          ${renderModelRows(build.models)}
        </tbody>
      </table>
    </div>` : ''}

    <div class="detail-actions">
      <button class="btn btn-secondary" id="btn-compare-from-detail">
        ⇌ Compare
      </button>
      <a href="${esc(build.sourceUrl)}" target="_blank" rel="noopener" class="btn btn-primary">
        View Listing ↗
      </a>
    </div>
    <div style="padding:8px 20px 14px;font-size:10px;color:var(--text-3)">
      Source: ${esc(build.sourceName || '')} &nbsp;·&nbsp; Updated ${fmtDate(build.scrapedAt)}
    </div>
  `;

  if (build.models && build.models.length) {
    initModelFilters(build.models);
  }
}

// ===== Model row rendering with in-panel filtering =====
let _currentBuildModels = [];

function renderModelRows(models) {
  if (!models || !models.length) return '<tr><td colspan="6" style="color:var(--text-3);font-size:12px">No models listed</td></tr>';
  return models.map((m) => `
  <tr>
    <td class="model-name">
      ${m.localImageUrl ? `<img src="${esc(m.localImageUrl)}" alt="${esc(m.name)}" style="width:60px;height:37px;object-fit:cover;border-radius:3px;margin-right:6px;vertical-align:middle">` : ''}
      ${m.modelUrl ? `<a href="${esc(m.modelUrl)}" target="_blank" rel="noopener" style="color:inherit">${esc(m.name)}</a>` : esc(m.name)}
    </td>
    <td style="font-size:11px;color:var(--text-3)">${esc(m.type || '')}</td>
    <td>${m.beds !== undefined && m.beds ? m.beds : '–'} bd / ${m.baths || '–'} ba</td>
    <td>${m.sqft ? m.sqft.toLocaleString() : '–'}</td>
    <td>${m.lotWidth ? m.lotWidth + ' ft' : '–'}</td>
    <td class="model-price">${m.priceFrom ? fmtPrice(m.priceFrom) : '—'}</td>
  </tr>`).join('');
}

function initModelFilters(models) {
  _currentBuildModels = models || [];
  const panel = tabPanels.detail;

  ['mf-beds', 'mf-baths', 'mf-sqft', 'mf-lot'].forEach((id) => {
    const el = panel.querySelector(`#${id}`);
    if (el) el.addEventListener('change', applyModelFilters);
  });
}

function applyModelFilters() {
  const panel = tabPanels.detail;
  const beds = parseFloat(panel.querySelector('#mf-beds')?.value || '0') || 0;
  const baths = parseFloat(panel.querySelector('#mf-baths')?.value || '0') || 0;
  const sqft = parseInt(panel.querySelector('#mf-sqft')?.value || '0', 10) || 0;
  const lot = parseInt(panel.querySelector('#mf-lot')?.value || '0', 10) || 0;

  const filtered = _currentBuildModels.filter((m) => {
    if (beds && (m.beds || 0) < beds) return false;
    if (baths && (m.baths || 0) < baths) return false;
    if (sqft && (m.sqft || 0) < sqft) return false;
    if (lot && (m.lotWidth || 0) < lot) return false;
    return true;
  });

  const tbody = panel.querySelector('#models-table-body tbody');
  if (tbody) tbody.innerHTML = renderModelRows(filtered);
}

// Helper to get price change from history if available (app.js injects this)
let _priceHistory = null;
export function setPriceHistory(h) { _priceHistory = h; }

function getPriceChange(build) {
  if (!_priceHistory || !build) return null;
  const snapshots = _priceHistory[build.id];
  if (!snapshots || snapshots.length < 2) return null;
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const delta = last.priceFrom - first.priceFrom;
  if (delta === 0) return null;
  return {
    delta,
    dir: delta > 0 ? 'up' : 'down',
    since: first.date,
  };
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtPrice(n) {
  if (!n) return '—';
  return '$' + n.toLocaleString('en-CA');
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

function fmtType(t) {
  const map = { 'single-family': 'Single Family', townhouse: 'Townhouse', 'semi-detached': 'Semi-Detached', condo: 'Condo', mixed: 'Mixed', unknown: 'Unknown' };
  return map[t] || t || '';
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return iso; }
}
