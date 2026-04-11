/**
 * History module — price sparklines + releases feed.
 */

let _priceHistory = null;
let _releases = null;

export function setHistoryData(prices, releases) {
  _priceHistory = prices;
  _releases = releases;
}

/**
 * Render the history tab for a given build.
 */
export function renderHistory(build) {
  const panel = document.getElementById('tab-history');

  if (!build) {
    panel.innerHTML = '<div class="history-empty">Select a community to see price history.</div>';
    return;
  }

  const snapshots = _priceHistory?.[build.id] || [];
  const relevantReleases = (_releases || []).filter((r) => r.buildId === build.id);

  let html = '';

  // --- Sparkline section ---
  if (snapshots.length >= 2) {
    html += renderSparkline(build, snapshots);
  } else if (snapshots.length === 1) {
    html += `<div class="sparkline-container">
      <div class="sparkline-title">Price History — ${esc(build.name)}</div>
      <div style="font-family:var(--mono);font-size:22px;color:var(--accent);margin-bottom:8px">${fmtPrice(snapshots[0].priceFrom)}</div>
      <div style="font-size:11px;color:var(--text-3)">First tracked on ${snapshots[0].date}. Run the scraper again to start tracking changes.</div>
    </div>`;
  } else {
    html += `<div class="sparkline-container">
      <div style="font-size:12px;color:var(--text-3)">No price history for this community yet.</div>
    </div>`;
  }

  // --- Model price table ---
  if (snapshots.length > 0) {
    const latest = snapshots[snapshots.length - 1];
    if (latest.models && Object.keys(latest.models).length > 0) {
      html += `<div class="detail-section">
        <div class="section-title">Latest Model Prices</div>
        <table class="models-table">
          <thead><tr><th>Model</th><th style="text-align:right">Price</th></tr></thead>
          <tbody>
            ${Object.entries(latest.models).map(([name, price]) => `
              <tr>
                <td class="model-name">${esc(name)}</td>
                <td class="model-price">${fmtPrice(price)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    }
  }

  // --- Releases for this build ---
  if (relevantReleases.length > 0) {
    html += `<div class="detail-section">
      <div class="section-title">Activity Log</div>
      <div class="releases-list" style="padding:0">
        ${relevantReleases.map(releaseItem).join('')}
      </div>
    </div>`;
  }

  // --- Global recent releases ---
  const recentAll = (_releases || []).slice(0, 8);
  if (recentAll.length > 0) {
    html += `<div class="detail-section">
      <div class="section-title">Recent Activity — All Ottawa</div>
      <div class="releases-list" style="padding:0">
        ${recentAll.map(releaseItem).join('')}
      </div>
    </div>`;
  }

  panel.innerHTML = html || '<div class="history-empty">No data available.</div>';
}

function renderSparkline(build, snapshots) {
  const prices = snapshots.map((s) => s.priceFrom);
  const dates = snapshots.map((s) => s.date);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const rangeP = maxP - minP || 1;

  const W = 320, H = 60, PAD = 4;
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;

  const points = prices.map((p, i) => {
    const x = PAD + (i / (prices.length - 1)) * innerW;
    const y = PAD + ((maxP - p) / rangeP) * innerH;
    return `${x},${y}`;
  });

  const polyline = points.join(' ');

  // Area fill
  const areaPoints = `${PAD},${H - PAD} ${polyline} ${PAD + innerW},${H - PAD}`;

  const delta = prices[prices.length - 1] - prices[0];
  const pct = ((delta / prices[0]) * 100).toFixed(1);
  const changeClass = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral';
  const changeLabel = delta > 0
    ? `▲ ${fmtPrice(delta)} (+${pct}%) since ${dates[0]}`
    : delta < 0
    ? `▼ ${fmtPrice(Math.abs(delta))} (${pct}%) since ${dates[0]}`
    : 'No change';

  const lineColor = delta > 0 ? 'var(--red)' : delta < 0 ? 'var(--green)' : 'var(--accent)';
  const fillColor = delta > 0 ? 'rgba(239,68,68,0.08)' : delta < 0 ? 'rgba(34,197,94,0.08)' : 'rgba(0,212,255,0.08)';

  // Tooltip dots
  const dots = points.map((pt, i) => {
    const [x, y] = pt.split(',');
    return `<circle cx="${x}" cy="${y}" r="3" fill="${lineColor}" class="sparkline-dot" data-date="${dates[i]}" data-price="${fmtPrice(prices[i])}"/>`;
  }).join('');

  return `<div class="sparkline-container">
    <div class="sparkline-title">
      <span>Price History — ${esc(build.name)}</span>
      <span class="sparkline-change ${changeClass}">${changeLabel}</span>
    </div>
    <svg class="sparkline-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <polygon points="${areaPoints}" fill="${fillColor}" stroke="none"/>
      <polyline points="${polyline}" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>
    <div class="sparkline-dates">
      <span>${dates[0]}</span>
      ${dates.length > 2 ? `<span>${dates[Math.floor(dates.length / 2)]}</span>` : ''}
      <span>${dates[dates.length - 1]}</span>
    </div>
  </div>`;
}

function releaseItem(r) {
  const iconMap = { new_build: { icon: '🏗', cls: 'new-build' }, price_change: { icon: '📈', cls: 'price-change' }, new_model: { icon: '✦', cls: 'new-model' } };
  const { icon, cls } = iconMap[r.type] || { icon: '•', cls: '' };

  let detail = '';
  if (r.type === 'price_change') {
    const dir = r.delta > 0 ? '▲' : '▼';
    detail = `${dir} ${fmtPrice(Math.abs(r.delta))} &nbsp;(${fmtPrice(r.oldPrice)} → ${fmtPrice(r.newPrice)})`;
    if (r.model) detail += ` · ${esc(r.model)}`;
  } else if (r.type === 'new_model') {
    detail = `${esc(r.model)} · from ${fmtPrice(r.priceFrom)}`;
  } else if (r.type === 'new_build') {
    detail = `${esc(r.builder)} · from ${fmtPrice(r.priceFrom)}`;
  }

  return `<div class="release-item">
    <div class="release-icon ${cls}">${icon}</div>
    <div class="release-body">
      <div class="release-name">${esc(r.name || r.builder)}</div>
      <div class="release-detail">${detail}</div>
    </div>
    <div class="release-date">${r.date}</div>
  </div>`;
}

function fmtPrice(n) {
  if (!n) return '—';
  return '$' + Number(n).toLocaleString('en-CA');
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
