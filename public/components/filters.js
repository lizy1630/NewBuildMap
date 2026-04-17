/**
 * Filters component — dropdowns + builder legend multi-select.
 */

// ── Geographic area grouping ──────────────────────────────────────────────
// Maps build.community → one of the user-facing area options
const AREA_MAP = {
  // Ottawa Urban (Nepean, East, West, South, Central)
  'Alta Vista / East':    'Ottawa Urban',
  'Rockcliffe Park':      'Ottawa Urban',
  'Nepean':               'Ottawa Urban',
  'Ottawa West':          'Ottawa Urban',
  'Ottawa East':          'Ottawa Urban',
  'Ottawa South':         'Ottawa Urban',
  'Ottawa':               'Ottawa Urban',
  'Centretown':           'Ottawa Urban',
  // Barrhaven (incl. Half Moon Bay, Stonebridge, Riverside South)
  'Barrhaven':            'Barrhaven',
  'Riverside South':      'Barrhaven',
  'Half Moon Bay':        'Barrhaven',
  'Stonebridge':          'Barrhaven',
  // Kanata
  'Kanata':               'Kanata',
  'Kanata North':         'Kanata',
  'Kanata South':         'Kanata',
  'Stittsville / Kanata': 'Kanata',
  // Orléans
  'Orléans':              'Orléans',
  'Orleans':              'Orléans',
  // Stittsville
  'Stittsville':          'Stittsville',
  // Richmond
  'Richmond':             'Richmond',
  'Richmond Village':     'Richmond',
  'Kemptville':           'Richmond',
  // Findlay Creek
  'Findlay Creek':        'Findlay Creek',
  'Leitrim / Findlay Creek': 'Findlay Creek',
  'Leitrim':              'Findlay Creek',
  // Manotick
  'Manotick':             'Manotick',
};

const AREAS = [
  'Ottawa Urban',
  'Barrhaven',
  'Kanata',
  'Orléans',
  'Stittsville',
  'Richmond',
  'Findlay Creek',
  'Manotick',
];

export function getArea(build) {
  return AREA_MAP[build.community] || null;
}

// Maps any fine-grained homeType label → one of the 3 big categories
const BIG_CATEGORY = {
  // Single Family
  'Single Family':   'Single Family',
  'Bungalows':       'Single Family',
  // Townhomes
  'Townhomes':                  'Townhomes',
  'Urban Towns':                'Townhomes',
  'Thrive Towns':               'Townhomes',
  'Bungalow Towns':             'Townhomes',
  'Semi-Detached':              'Townhomes',
  'Multi-Gen':                  'Townhomes',
  'Tandem':                     'Townhomes',
  'Two-Storey Freehold Towns':  'Townhomes',
  'Double Car Garage Towns':    'Townhomes',
  'The Summit Series':          'Townhomes',
  // Condo
  'Flats':  'Condo',
  'Condo':  'Condo',
};

const communityEl  = document.getElementById('filter-community');
const homeTypeEl   = document.getElementById('filter-hometype');
const bedsEl       = document.getElementById('filter-beds');
const bathsEl      = document.getElementById('filter-baths');
const sqftEl       = document.getElementById('filter-sqft');
const lotEl        = document.getElementById('filter-lot');
const countEl      = document.getElementById('count-num');

let _onChange = null;

// Multi-select builder set — empty means ALL visible
let _activeBuilders = new Set();

export function initFilters(builds, onChange) {
  _onChange = onChange;

  // Populate area filter with geographic sections
  AREAS.forEach((area) => {
    const opt = document.createElement('option');
    opt.value = area;
    opt.textContent = area;
    communityEl.appendChild(opt);
  });

  // homeType options are static in HTML (3 big categories)
  [communityEl, homeTypeEl, bedsEl, bathsEl, sqftEl, lotEl].forEach((el) =>
    el.addEventListener('change', () => _onChange && _onChange(getFilters()))
  );
}

/**
 * Build the legend — call after map markers are created so BUILDER_COLORS is available.
 * @param {Array}    builds       - all build objects
 * @param {Function} colorFn     - builderColor(builder) → hex
 */
export function initLegend(builds, colorFn) {
  const builders = [...new Set(builds.map((b) => b.builder))].sort();

  const html = builders.map((b) => {
    const color = colorFn(b);
    return `
      <div class="legend-item" data-builder="${escAttr(b)}" title="${escAttr(b)}">
        <span class="legend-dot" style="background:${color};box-shadow:0 0 4px ${color}88"></span>
        <span class="legend-label">${esc(b)}</span>
      </div>`;
  }).join('');

  // Populate both desktop and mobile legend containers
  ['builder-legend', 'builder-legend-mobile'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = html;
    el.querySelectorAll('.legend-item').forEach((item) => {
      item.addEventListener('click', () => {
        const builder = item.dataset.builder;
        // Sync active state across both legends
        const allItems = document.querySelectorAll(`.legend-item[data-builder="${escAttr(builder)}"]`);
        if (_activeBuilders.has(builder)) {
          _activeBuilders.delete(builder);
          allItems.forEach(i => i.classList.remove('active'));
        } else {
          _activeBuilders.add(builder);
          allItems.forEach(i => i.classList.add('active'));
        }
        if (_onChange) _onChange(getFilters());
      });
    });
  });
}

export function getFilters() {
  return {
    community:  communityEl.value,
    builders:   _activeBuilders.size > 0 ? new Set(_activeBuilders) : null, // null = all
    homeType:   homeTypeEl.value,
    beds:       parseFloat(bedsEl.value) || 0,
    baths:      parseFloat(bathsEl.value) || 0,
    sqft:       parseInt(sqftEl.value, 10) || 0,
    lot:        parseInt(lotEl.value, 10) || 0,
  };
}

export function updateCount(n) {
  countEl.textContent = n;
}

/**
 * Programmatically activate a builder filter — same effect as clicking the legend item.
 * Toggles the builder into the active set (or activates it exclusively if not yet active).
 */
export function activateBuilderFilter(builder) {
  // If already the only active builder, deactivate (show all)
  if (_activeBuilders.size === 1 && _activeBuilders.has(builder)) {
    _activeBuilders.delete(builder);
    document.querySelector(`.legend-item[data-builder="${builder.replace(/"/g, '&quot;')}"]`)?.classList.remove('active');
  } else {
    // Clear others, activate this one
    _activeBuilders.clear();
    document.querySelectorAll('.legend-item').forEach((item) => item.classList.remove('active'));
    _activeBuilders.add(builder);
    document.querySelector(`.legend-item[data-builder="${builder.replace(/"/g, '&quot;')}"]`)?.classList.add('active');
  }
  if (_onChange) _onChange(getFilters());
}

export function matchesFilters(build, filters) {
  if (filters.community && getArea(build) !== filters.community) return false;
  if (filters.builders  && !filters.builders.has(build.builder))  return false;
  if (filters.homeType) {
    const cats = (build.homeTypes || []).map(t => BIG_CATEGORY[t] || 'Single Family');
    if (!cats.includes(filters.homeType)) return false;
  }

  const needsModelFilter = filters.beds || filters.baths || filters.sqft || filters.lot;
  if (needsModelFilter) {
    const models = build.models || [];
    if (!models.length) return false;
    const hasMatch = models.some((m) => {
      if (filters.beds  && (m.beds     || 0) < filters.beds)  return false;
      if (filters.baths && (m.baths    || 0) < filters.baths) return false;
      if (filters.sqft  && (m.sqft     || 0) < filters.sqft)  return false;
      if (filters.lot   && (m.lotWidth || 0) < filters.lot)   return false;
      return true;
    });
    if (!hasMatch) return false;
  }

  return true;
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  if (s == null) return '';
  return String(s).replace(/"/g, '&quot;');
}
