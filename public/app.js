/**
 * Ottawa New Build Map — Main App
 */
import { initSidebar, openSidebar, closeSidebar, switchTab, renderDetail, setPriceHistory } from './components/sidebar.js';
import { initFilters, getFilters, updateCount, matchesFilters, setCommunityFilter } from './components/filters.js';
import { showRecentReleases } from './components/toast.js';
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

const TYPE_COLORS = {
  'single-family': '#22c55e',
  townhouse: '#3b82f6',
  'semi-detached': '#a855f7',
  condo: '#f59e0b',
  mixed: '#00d4ff',
  unknown: '#9090b0',
};

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
let isDark = true;
let allBuilds = [];
let priceHistory = {};
let releases = [];

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
  });

  map.zoomControl.setPosition('bottomright');

  tileLayer = L.tileLayer(TILES.dark.url, {
    attribution: TILES.dark.attr,
    maxZoom: 19,
    subdomains: 'abcd',
  }).addTo(map);

  // Init modules
  initSidebar({ onTabChange: handleTabChange });
  initFilters(allBuilds, handleFiltersChange);
  initCompare(allBuilds, { onSelectingBChange: handleSelectingBChange });

  // Create markers
  allBuilds.forEach((build) => {
    if (!build.lat || !build.lng) return;

    const color = TYPE_COLORS[build.type] || TYPE_COLORS.unknown;
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

    // Hover effects
    marker.on('mouseover', () => {
      if (activeId !== build.id) {
        marker.setStyle({ radius: 12, fillOpacity: 0.5 * opacity, weight: 2.5 });
      }
      marker.openPopup();
    });

    marker.on('mouseout', () => {
      if (activeId !== build.id) {
        marker.setStyle({ radius: 9, fillOpacity: 0.25 * opacity, weight: 2 });
      }
      marker.closePopup();
    });

    marker.on('click', () => handleMarkerClick(build, marker, color, opacity));

    marker.addTo(map);
    markers.push({ build, marker, visible: true });
  });

  // Viewport count
  map.on('moveend zoomend', updateViewportCount);
  updateViewportCount();
  applyFilters();

  // Theme toggle
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // Recent releases toasts (delayed so map loads first)
  setTimeout(() => showRecentReleases(releases, 7), 1500);

  // Handle compare button in detail panel (delegated)
  document.getElementById('tab-detail').addEventListener('click', (e) => {
    if (e.target.id === 'btn-compare-from-detail') {
      const build = allBuilds.find((b) => b.id === activeId);
      if (build) startCompare(build);
    }
  });

  // Restore hash state
  handleHash();
}

// ===== Marker click =====
function handleMarkerClick(build, marker, color, opacity) {
  // Compare B selection mode
  if (isSelectingB()) {
    setCompareB(build);
    return;
  }

  // Deselect previous
  if (activeId && activeId !== build.id) {
    const prev = markers.find((m) => m.build.id === activeId);
    if (prev) {
      const c = TYPE_COLORS[prev.build.type] || TYPE_COLORS.unknown;
      const op = STATUS_OPACITY[prev.build.status] ?? 0.9;
      prev.marker.setStyle({ radius: 9, fillOpacity: 0.25 * op, weight: 2, color: c, fillColor: c });
    }
  }

  activeId = build.id;
  marker.setStyle({ radius: 11, fillOpacity: 0.6 * opacity, weight: 3, color: '#ffffff', fillColor: color });
  marker.closePopup();

  // Pre-fill community filter to the clicked community
  setCommunityFilter(build.community);

  renderDetail(build);
  renderHistory(build);

  openSidebar();
  switchTab('detail');
}

// ===== Popup HTML =====
function buildPopupHTML(build) {
  const color = TYPE_COLORS[build.type] || TYPE_COLORS.unknown;
  return `
    <div class="map-popup">
      <div class="popup-header" style="border-left:3px solid ${color}">
        <div class="popup-name">${esc(build.name)}</div>
        <div class="popup-builder">${esc(build.builder)} · ${esc(build.community)}</div>
      </div>
      <div class="popup-body">
        <div class="popup-price">${build.priceFromFormatted || '—'}</div>
        <div class="popup-meta">
          ${build.completionYear ? `<span class="badge badge-year">${build.completionYear}</span>` : ''}
          ${homeTypeBadges(build)}
        </div>
        ${build.models?.length ? `<div style="font-size:11px;color:var(--text-3)">${build.models.length} floor plan${build.models.length > 1 ? 's' : ''} available</div>` : ''}
      </div>
      <button class="popup-detail-btn" onclick="window.__mapShowDetail('${build.id}')">
        View Details →
      </button>
    </div>`;
}

// Global for popup button onclick
window.__mapShowDetail = (id) => {
  const item = markers.find((m) => m.build.id === id);
  if (item) {
    item.marker.closePopup();
    const color = TYPE_COLORS[item.build.type] || TYPE_COLORS.unknown;
    const opacity = STATUS_OPACITY[item.build.status] ?? 0.9;
    handleMarkerClick(item.build, item.marker, color, opacity);
  }
};

// ===== Filters =====
function handleFiltersChange(filters) {
  applyFilters(filters);
}

function applyFilters(filters) {
  if (!filters) filters = getFilters();
  let visible = 0;

  markers.forEach(({ build, marker }) => {
    const show = matchesFilters(build, filters);
    if (show) {
      marker.setOpacity(1);
      marker.getElement()?.style.setProperty('pointer-events', 'auto');
      visible++;
    } else {
      marker.setOpacity(0);
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
        const color = TYPE_COLORS[build.type] || TYPE_COLORS.unknown;
        const opacity = STATUS_OPACITY[build.status] ?? 0.9;
        handleMarkerClick(build, item.marker, color, opacity);
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
