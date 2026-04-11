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
        <span class="badge ${statusClass}">${fmtStatus(build.status)}</span>
        <span class="badge badge-type">${fmtType(build.type)}</span>
        ${build.completionYear ? `<span class="badge badge-type">${build.completionYear}</span>` : ''}
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
      <table class="models-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Bed/Bath</th>
            <th>Sqft</th>
            <th style="text-align:right">From</th>
          </tr>
        </thead>
        <tbody>
          ${build.models.map((m) => `
          <tr>
            <td class="model-name">${esc(m.name)}</td>
            <td>${m.beds !== undefined ? m.beds : '–'} bd / ${m.baths || '–'} ba</td>
            <td>${m.sqft ? m.sqft.toLocaleString() : '–'}</td>
            <td class="model-price">${m.priceFrom ? fmtPrice(m.priceFrom) : '—'}</td>
          </tr>`).join('')}
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
