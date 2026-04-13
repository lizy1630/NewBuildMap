/**
 * Filters component — dropdowns + builder legend multi-select.
 */

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

  // Populate community list
  const communities = [...new Set(builds.map((b) => b.community))].sort();
  communities.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    communityEl.appendChild(opt);
  });

  // Populate home types
  const allTypes = new Set();
  builds.forEach((b) => (b.homeTypes || []).forEach((t) => allTypes.add(t)));
  [...allTypes].sort().forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    homeTypeEl.appendChild(opt);
  });

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
  const el = document.getElementById('builder-legend');
  if (!el) return;

  const builders = [...new Set(builds.map((b) => b.builder))].sort();

  el.innerHTML = builders.map((b) => {
    const color = colorFn(b);
    return `
      <div class="legend-item" data-builder="${escAttr(b)}" title="${escAttr(b)}">
        <span class="legend-dot" style="background:${color};box-shadow:0 0 4px ${color}88"></span>
        <span class="legend-label">${esc(b)}</span>
      </div>`;
  }).join('');

  el.querySelectorAll('.legend-item').forEach((item) => {
    item.addEventListener('click', () => {
      const builder = item.dataset.builder;
      if (_activeBuilders.has(builder)) {
        _activeBuilders.delete(builder);
        item.classList.remove('active');
      } else {
        _activeBuilders.add(builder);
        item.classList.add('active');
      }
      // If all deselected, treat as show-all
      if (_onChange) _onChange(getFilters());
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

export function matchesFilters(build, filters) {
  if (filters.community && build.community !== filters.community) return false;
  if (filters.builders  && !filters.builders.has(build.builder))  return false;
  if (filters.homeType  && !(build.homeTypes || []).includes(filters.homeType)) return false;

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
