/**
 * Filters component — populates dropdowns and returns active filter state.
 */

const typeEl = document.getElementById('filter-type');
const builderEl = document.getElementById('filter-builder');
const statusEl = document.getElementById('filter-status');
const countEl = document.getElementById('count-num');

let _onChange = null;

/**
 * Initialise filters with available builders from data.
 * @param {Array} builds
 * @param {Function} onChange - called with filter object on any change
 */
export function initFilters(builds, onChange) {
  _onChange = onChange;

  // Populate builder list
  const builders = [...new Set(builds.map((b) => b.builder))].sort();
  builders.forEach((b) => {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = b;
    builderEl.appendChild(opt);
  });

  [typeEl, builderEl, statusEl].forEach((el) =>
    el.addEventListener('change', () => _onChange && _onChange(getFilters()))
  );
}

export function getFilters() {
  return {
    type: typeEl.value,
    builder: builderEl.value,
    status: statusEl.value,
  };
}

export function updateCount(n) {
  countEl.textContent = n;
}

/**
 * Test a single build against current filters.
 */
export function matchesFilters(build, filters) {
  if (filters.type && build.type !== filters.type) return false;
  if (filters.builder && build.builder !== filters.builder) return false;
  if (filters.status && build.status !== filters.status) return false;
  return true;
}
