/**
 * Filters component — populates dropdowns and returns active filter state.
 */

const communityEl = document.getElementById('filter-community');
const builderEl = document.getElementById('filter-builder');
const homeTypeEl = document.getElementById('filter-hometype');
const bedsEl = document.getElementById('filter-beds');
const bathsEl = document.getElementById('filter-baths');
const sqftEl = document.getElementById('filter-sqft');
const lotEl = document.getElementById('filter-lot');
const countEl = document.getElementById('count-num');

let _onChange = null;

/**
 * Initialise filters with available data from builds.
 * @param {Array} builds
 * @param {Function} onChange - called with filter object on any change
 */
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

  // Populate builder list
  const builders = [...new Set(builds.map((b) => b.builder))].sort();
  builders.forEach((b) => {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = b;
    builderEl.appendChild(opt);
  });

  // Populate home types from all homeTypes arrays
  const allTypes = new Set();
  builds.forEach((b) => {
    (b.homeTypes || []).forEach((t) => allTypes.add(t));
  });
  [...allTypes].sort().forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    homeTypeEl.appendChild(opt);
  });

  [communityEl, builderEl, homeTypeEl, bedsEl, bathsEl, sqftEl, lotEl].forEach((el) =>
    el.addEventListener('change', () => _onChange && _onChange(getFilters()))
  );
}

export function getFilters() {
  return {
    community: communityEl.value,
    builder: builderEl.value,
    homeType: homeTypeEl.value,
    beds: parseFloat(bedsEl.value) || 0,
    baths: parseFloat(bathsEl.value) || 0,
    sqft: parseInt(sqftEl.value, 10) || 0,
    lot: parseInt(lotEl.value, 10) || 0,
  };
}

export function updateCount(n) {
  countEl.textContent = n;
}

/**
 * Set the community filter programmatically (e.g. from map click).
 */
export function setCommunityFilter(community) {
  communityEl.value = community || '';
  if (_onChange) _onChange(getFilters());
}

/**
 * Test a single build against current filters.
 * For model-level filters (beds/baths/sqft/lot), the build matches if ANY model satisfies them.
 */
export function matchesFilters(build, filters) {
  if (filters.community && build.community !== filters.community) return false;
  if (filters.builder && build.builder !== filters.builder) return false;
  if (filters.homeType && !(build.homeTypes || []).includes(filters.homeType)) return false;

  // Model-level filters: pass if at least one model matches
  const needsModelFilter = filters.beds || filters.baths || filters.sqft || filters.lot;
  if (needsModelFilter) {
    const models = build.models || [];
    if (!models.length) return false;
    const hasMatch = models.some((m) => {
      if (filters.beds && (m.beds || 0) < filters.beds) return false;
      if (filters.baths && (m.baths || 0) < filters.baths) return false;
      if (filters.sqft && (m.sqft || 0) < filters.sqft) return false;
      if (filters.lot && (m.lotWidth || 0) < filters.lot) return false;
      return true;
    });
    if (!hasMatch) return false;
  }

  return true;
}
