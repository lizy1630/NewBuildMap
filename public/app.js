/**
 * Ottawa New Build Map — Main App
 */
import { initSidebar, openSidebar, closeSidebar, switchTab, renderDetail, setPriceHistory, setBuilderColorFn, setBuilderClickFn } from './components/sidebar.js';
import { initFilters, initLegend, getFilters, updateCount, matchesFilters, activateBuilderFilter } from './components/filters.js';
import { showRecentReleases } from './components/toast.js';
import { initLeadModal } from './lead.js';
import { initCompare, startCompare, setCompareB, isSelectingB, renderCompare } from './compare.js';
import { setHistoryData, renderHistory } from './history.js';

// ===== Map tile layers =====
const TILES = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
};

const BUILDER_COLORS = {
  'Minto Communities':       '#00d4ff',
  'Mattamy Homes':           '#f59e0b',
  'Cardel Homes':            '#22c55e',
  'Richcraft Homes':         '#f43f5e',
  'HN Homes':                '#a855f7',
  'Urbandale Construction':  '#fb923c',
  'Glenview Homes':          '#06b6d4',
  'Tamarack Homes':          '#84cc16',
  'Tartan Homes':            '#e879f9',
  'Valecraft Homes':         '#facc15',
  'Patten Homes':            '#34d399',
  'Caivan':                  '#60a5fa',
  'eQ Homes':                '#f472b6',
  'Phoenix Homes':           '#38bdf8',
  'Brigil':                  '#a3e635',
};

function builderColor(builder) {
  return BUILDER_COLORS[builder] || '#9090b0';
}

const STATUS_OPACITY = {
  selling: 1,
  limited: 0.85,
  upcoming: 0.7,
  'sold-out': 0.35,
  construction: 0.75,
};

// ===== State =====
let map;
let tileLayer;
let markers = [];   // { build, marker, visible }
let activeId = null;
let isDark = false;
let allBuilds = [];
let priceHistory = {};
let releases = [];
let _blockMapClick = false;

function blockMapClick() {
  _blockMapClick = true;
  setTimeout(() => { _blockMapClick = false; }, 400);
}

function deselectActive() {
  if (activeId) {
    const prev = markers.find((m) => m.build.id === activeId);
    if (prev) {
      const c = builderColor(prev.build.builder);
      const op = STATUS_OPACITY[prev.build.status] ?? 0.9;
      prev.marker.setStyle({ radius: 9, fillOpacity: 0.25 * op, weight: 2, color: c, fillColor: c });
    }
    activeId = null;
  }
}

// ===== Init =====
async function init() {
  // Load data
  try {
    const [buildsRes, historyRes, releasesRes] = await Promise.all([
      fetch('./data/builds.json'),
      fetch('./data/history/prices.json'),
      fetch('./data/history/releases.json'),
    ]);
    const buildsData = await buildsRes.json();
    allBuilds = buildsData.builds || [];
    priceHistory = await historyRes.json();
    releases = await releasesRes.json();
  } catch (err) {
    console.error('Failed to load data:', err);
    allBuilds = [];
  }

  // Inject history into sidebar module
  setPriceHistory(priceHistory);
  setHistoryData(priceHistory, releases);

  // Init map
  map = L.map('map', {
    center: [45.35, -75.78],
    zoom: 11,
    zoomControl: true,
    attributionControl: true,
    doubleClickZoom: false,
  });

  map.zoomControl.setPosition('bottomright');

  tileLayer = L.tileLayer(TILES.light.url, {
    attribution: TILES.light.attr,
    maxZoom: 19,
    subdomains: 'abcd',
  }).addTo(map);

  // Force Leaflet to recalculate dimensions once DOM is settled
  setTimeout(() => map.invalidateSize(), 0);

  // Init modules
  initSidebar({ onTabChange: handleTabChange });
  setBuilderColorFn(builderColor);
  setBuilderClickFn((builder) => activateBuilderFilter(builder));
  initFilters(allBuilds, handleFiltersChange);
  initCompare(allBuilds, { onSelectingBChange: handleSelectingBChange });

  // Create markers
  allBuilds.forEach((build) => {
    if (!build.lat || !build.lng) return;

    const color = builderColor(build.builder);
    const opacity = STATUS_OPACITY[build.status] ?? 0.9;

    const marker = L.circleMarker([build.lat, build.lng], {
      radius: 9,
      color: color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.25 * opacity,
      opacity: opacity,
      className: `marker-${build.id}`,
    });

    // Popup
    marker.bindPopup(buildPopupHTML(build), {
      closeButton: false,
      maxWidth: 280,
      className: 'map-popup-wrapper',
    });

    // Hover effects — delay close so cursor can move into popup without it disappearing
    let _hoverTimer = null;
    const cancelClose = () => clearTimeout(_hoverTimer);
    const scheduleClose = () => {
      _hoverTimer = setTimeout(() => {
        if (activeId !== build.id) marker.closePopup();
      }, 250);
    };

    marker.on('mouseover', () => {
      cancelClose();
      if (activeId !== build.id) {
        marker.setStyle({ radius: 12, fillOpacity: 0.5 * opacity, weight: 2.5 });
      }
      marker.openPopup();
    });

    marker.on('mouseout', () => {
      if (activeId !== build.id) {
        marker.setStyle({ radius: 9, fillOpacity: 0.25 * opacity, weight: 2 });
      }
      scheduleClose();
    });

    marker.on('popupopen', () => {
      const popupEl = marker.getPopup()?.getElement();
      if (popupEl) {
        popupEl.addEventListener('mouseenter', cancelClose);
        popupEl.addEventListener('mouseleave', scheduleClose);
        // Prevent popup clicks bubbling to map (fixes "View Details" closing immediately)
        L.DomEvent.disableClickPropagation(popupEl);
      }
    });

    marker.on('click', (e) => { L.DomEvent.stopPropagation(e); handleMarkerClick(build, marker, color, opacity); });

    marker.addTo(map);
    markers.push({ build, marker, visible: true });
  });

  // Builder legend (after markers so builderColor is defined)
  initLegend(allBuilds, builderColor);

  // Viewport count
  map.on('moveend zoomend', updateViewportCount);
  updateViewportCount();
  applyFilters();

  // Close sidebar on map background click (desktop and mobile)
  map.on('click', () => {
    if (_blockMapClick) return;
    deselectActive();
    closeSidebar();
  });

  // Lead modal
  initLeadModal();

  // Hide loading screen and let Leaflet recalculate map size
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) {
    loadingScreen.classList.add('loaded');
    setTimeout(() => {
      loadingScreen.remove();
      // Leaflet needs to know the container is now fully visible
      map.invalidateSize();
    }, 400);
  } else {
    map.invalidateSize();
  }

  // Theme toggle
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // Mobile filter toggle
  const btnFilters = document.getElementById('btn-filters-toggle');
  const filtersRow = document.getElementById('topbar-filters');
  if (btnFilters && filtersRow) {
    btnFilters.addEventListener('click', () => {
      const open = filtersRow.classList.toggle('open');
      btnFilters.style.color = open ? 'var(--accent)' : '';
      btnFilters.style.borderColor = open ? 'var(--accent)' : '';
    });
  }

  // Mobile legend toggle
  const btnLegend = document.getElementById('btn-legend-toggle');
  const legendDrawer = document.getElementById('mobile-legend-drawer');
  if (btnLegend && legendDrawer) {
    btnLegend.addEventListener('click', () => {
      const open = legendDrawer.classList.toggle('open');
      btnLegend.style.color = open ? 'var(--accent)' : '';
      btnLegend.style.borderColor = open ? 'var(--accent)' : '';
    });
  }

  // Recent releases toasts (delayed so map loads first)
  setTimeout(() => showRecentReleases(releases, 7), 1500);

  // Handle compare button in detail panel (delegated)
  document.getElementById('tab-detail').addEventListener('click', (e) => {
    const btn = e.target.closest('#btn-compare-from-detail');
    if (btn) {
      const build = allBuilds.find((b) => b.id === activeId);
      if (build) startCompare(build);
    }
  });

  // Restore hash state
  handleHash();
}

// ===== Marker click — highlight marker and show popup only =====
function handleMarkerClick(build, marker, color, opacity) {
  blockMapClick();

  // Compare B selection mode
  if (isSelectingB()) {
    setCompareB(build);
    return;
  }

  // Deselect previous marker
  if (activeId !== build.id) deselectActive();

  activeId = build.id;
  marker.setStyle({ radius: 11, fillOpacity: 0.6 * opacity, weight: 3, color: '#ffffff', fillColor: color });

  // Don't open sidebar here — only "View Details" opens it
}

// ===== Open detail sidebar (called by "View Details" button) =====
function openDetailForBuild(build) {
  blockMapClick();

  renderDetail(build);
  renderHistory(build);

  openSidebar();
  switchTab('detail');
}

// ===== Popup HTML =====
function buildPopupHTML(build) {
  const color = builderColor(build.builder);
  const priceVal = build.priceFromFormatted;
  const hasPrice = priceVal && !priceVal.toLowerCase().includes('not available') && build.priceFrom;
  const priceHtml = hasPrice
    ? `<span class="popup-price-from">From </span><span>${priceVal}</span>`
    : `<span class="popup-price-from">From </span><span class="popup-price-na">UNAVAILABLE</span>`;

  // Support multiple statuses (e.g. sold-out + coming-soon)
  const statuses = build.statuses || (build.status ? [build.status] : []);
  const statusBadges = statuses.map(s => {
    if (s === 'sold-out')    return `<span class="badge badge-sold">Sold Out</span>`;
    if (s === 'coming-soon') return `<span class="badge badge-soon">Coming Soon</span>`;
    if (s === 'upcoming')    return `<span class="badge badge-soon">Coming Soon</span>`;
    return '';
  }).join('');

  const isSoldOut   = statuses.includes('sold-out');
  const isComingSoon = statuses.includes('coming-soon') || statuses.includes('upcoming');

  return `
    <div class="map-popup">
      <div class="popup-header" style="border-left:3px solid ${color}">
        <div class="popup-name">${esc(build.name)}</div>
        <div class="popup-builder">${esc(build.builder)} · ${esc(build.community)}</div>
      </div>
      <div class="popup-body">
        <div class="popup-price">${priceHtml}</div>
        <div class="popup-meta">
          ${statusBadges}
          ${build.completionYear ? `<span class="badge badge-year">${build.completionYear}</span>` : ''}
          ${homeTypeBadges(build)}
        </div>
        ${build.models?.length ? `<div style="font-size:11px;color:var(--text-3)">${build.models.length} floor plan${build.models.length > 1 ? 's' : ''} available</div>` : ''}
      </div>
      ${isSoldOut && !isComingSoon
        ? `<div class="popup-sold-out">Sold Out</div>`
        : `<button class="popup-detail-btn" onclick="window.__mapShowDetail('${build.id}')">View Details →</button>`
      }
    </div>`;
}

// Globals for popup buttons
window.__openLeadModal = () => { import('./lead.js').then(m => m.openLeadModal()); };

window.__mapShowDetail = (id) => {
  const item = markers.find((m) => m.build.id === id);
  if (item) {
    item.marker.closePopup();
    openDetailForBuild(item.build);
  }
};

// ===== Filters =====
function handleFiltersChange(filters) {
  applyFilters(filters);
  window.dispatchEvent(new CustomEvent('filters-changed'));
}

function applyFilters(filters) {
  if (!filters) filters = getFilters();
  let visible = 0;

  markers.forEach(({ build, marker }) => {
    const show = matchesFilters(build, filters);
    const opacity = STATUS_OPACITY[build.status] ?? 0.9;
    if (show) {
      marker.setStyle({ opacity: opacity, fillOpacity: 0.25 * opacity });
      marker.getElement()?.style.setProperty('pointer-events', 'auto');
      visible++;
    } else {
      marker.setStyle({ opacity: 0, fillOpacity: 0 });
      marker.getElement()?.style.setProperty('pointer-events', 'none');
    }
  });

  updateCount(visible);
}

function updateViewportCount() {
  const bounds = map.getBounds();
  let n = 0;
  const filters = getFilters();
  markers.forEach(({ build, marker }) => {
    if (!matchesFilters(build, filters)) return;
    const ll = marker.getLatLng();
    if (bounds.contains(ll)) n++;
  });
  updateCount(n);
}

// ===== Tab switching =====
function handleTabChange(tab) {
  const build = allBuilds.find((b) => b.id === activeId);
  if (tab === 'history') renderHistory(build || null);
  if (tab === 'compare') renderCompare();
}

// ===== Compare B selection state =====
function handleSelectingBChange(selecting) {
  // Highlight all non-A markers when selecting
  if (selecting) {
    markers.forEach(({ build, marker }) => {
      if (build.id !== activeId) {
        marker.setStyle({ weight: 2, fillOpacity: 0.4 });
      }
    });
  }
}

// ===== Theme =====
function toggleTheme() {
  isDark = !isDark;
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

  const tile = isDark ? TILES.dark : TILES.light;
  tileLayer.setUrl(tile.url);
  document.getElementById('btn-theme').textContent = isDark ? '☀' : '☾';
}

// ===== Hash routing =====
function handleHash() {
  const hash = window.location.hash;
  if (!hash) return;

  // Single build: #detail=id
  const detailM = hash.match(/detail=([^&]+)/);
  if (detailM) {
    const build = allBuilds.find((b) => b.id === detailM[1]);
    if (build) {
      const item = markers.find((m) => m.build.id === build.id);
      if (item) {
        map.setView([build.lat, build.lng], 14);
        const color = builderColor(build.builder);
        const opacity = STATUS_OPACITY[build.status] ?? 0.9;
        item.marker.setStyle({ radius: 11, fillOpacity: 0.6 * opacity, weight: 3, color: '#ffffff', fillColor: color });
        activeId = build.id;
        openDetailForBuild(build);
      }
    }
  }
}

// ===== Helpers =====
function homeTypeBadges(build) {
  const types = getHomeTypes(build);
  return types.map(t => `<span class="badge badge-type">${esc(t)}</span>`).join('');
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
  const m = { selling: 'Selling', limited: 'Limited', 'sold-out': 'Sold Out', upcoming: 'Upcoming', construction: 'Under Const.' };
  return m[s] || s || '';
}

function fmtType(t) {
  const m = { 'single-family': 'Single Family', townhouse: 'Townhouse', 'semi-detached': 'Semi-Detached', condo: 'Condo', mixed: 'Mixed', unknown: 'Unknown' };
  return m[t] || t || '';
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== Start =====
init();
