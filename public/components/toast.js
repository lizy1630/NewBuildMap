const container = document.getElementById('toast-container');

const TYPE_ICONS = {
  new_build: '🏗',
  price_change: '📈',
  new_model: '✦',
};

const TYPE_LABELS = {
  new_build: 'New Community',
  price_change: 'Price Update',
  new_model: 'New Model',
};

/**
 * Show a single toast notification.
 * @param {{ title: string, body: string, accent?: string }} opts
 * @param {number} duration ms before auto-dismiss (0 = manual)
 */
export function showToast({ title, body, accent }, duration = 5000) {
  const el = document.createElement('div');
  el.className = 'toast';
  if (accent) el.style.borderLeftColor = accent;

  el.innerHTML = `
    <div class="toast-title">${title}</div>
    ${body ? `<div class="toast-body">${body}</div>` : ''}
  `;

  container.appendChild(el);

  if (duration > 0) {
    setTimeout(() => dismissToast(el), duration);
  }

  return el;
}

function dismissToast(el) {
  el.classList.add('exiting');
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

/**
 * Show toasts for recent releases (last N days).
 * @param {Array} releases - releases.json array
 * @param {number} days
 */
export function showRecentReleases(releases, days = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const recent = releases.filter((r) => new Date(r.date) >= cutoff);
  if (recent.length === 0) return;

  // Show at most 3 toasts, staggered
  recent.slice(0, 3).forEach((r, i) => {
    setTimeout(() => {
      const icon = TYPE_ICONS[r.type] || '•';
      const label = TYPE_LABELS[r.type] || r.type;

      let body = '';
      if (r.type === 'new_build') {
        body = `${r.builder} · from ${fmtPrice(r.priceFrom)}`;
      } else if (r.type === 'price_change') {
        const dir = r.delta > 0 ? '▲' : '▼';
        body = `${r.name} · ${dir} ${fmtPrice(Math.abs(r.delta))}`;
      } else if (r.type === 'new_model') {
        body = `${r.name} · ${r.model}`;
      }

      showToast({
        title: `${icon} ${label}: ${r.name || r.builder}`,
        body,
        accent: r.type === 'price_change' ? 'var(--red)' :
                r.type === 'new_build' ? 'var(--green)' : 'var(--blue)',
      });
    }, i * 800);
  });
}

function fmtPrice(n) {
  if (!n) return '—';
  return '$' + n.toLocaleString('en-CA');
}
