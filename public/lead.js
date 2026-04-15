/**
 * Lead capture & info-request system.
 *
 * Flow:
 *  1. "Request Info" clicked on community without a price sheet.
 *  2. Not registered → modal collects name / email / phone.
 *  3. Submit: saves to localStorage, notifies agent, marks community as requested.
 *  4. Already registered → request fires immediately, no modal.
 *  5. Same community revisited → button stays "✓ Request Sent".
 *  6. Per-model "🔒 Get price" still opens modal for price unlock.
 *
 * Email delivery: formsubmit.co (free, no backend needed).
 * First-ever submission triggers ONE verification email to the agent —
 * click that link once to activate, then all future submissions go through.
 */

const AGENT_EMAIL = 'lizy1630@gmail.com';
const LEAD_KEY    = 'nbm_lead';      // localStorage → { name, email, phone, ts }
const REQ_KEY     = 'nbm_requests';  // localStorage → ['build-id', ...]

let _unlocked     = false;
let _pendingBuild = null; // { id, name, community } set before modal opens

// ─────────────────────────────────────────────
// State helpers
// ─────────────────────────────────────────────

export function isRegistered() {
  return !!localStorage.getItem(LEAD_KEY);
}

export function isUnlocked() {
  if (_unlocked) return true;
  if (isRegistered()) { _unlocked = true; return true; }
  return false;
}

export function getUser() {
  try { return JSON.parse(localStorage.getItem(LEAD_KEY)); } catch { return null; }
}

export function hasRequested(buildId) {
  try {
    return JSON.parse(localStorage.getItem(REQ_KEY) || '[]').includes(buildId);
  } catch { return false; }
}

function markRequested(buildId) {
  try {
    const reqs = JSON.parse(localStorage.getItem(REQ_KEY) || '[]');
    if (!reqs.includes(buildId)) {
      reqs.push(buildId);
      localStorage.setItem(REQ_KEY, JSON.stringify(reqs));
    }
  } catch {}
}

// ─────────────────────────────────────────────
// Email via formsubmit.co (free, zero backend)
// ─────────────────────────────────────────────
async function sendNotification(user, build, type) {
  const subject = type === 'request'
    ? `[NewBuildMap] Info Request — ${build?.name || '?'} · ${build?.community || ''}`
    : `[NewBuildMap] New Registration — ${user.name || user.email}`;
  try {
    await fetch(`https://formsubmit.co/ajax/${AGENT_EMAIL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        _subject:  subject,
        _captcha:  'false',
        _template: 'table',
        Name:      user.name  || '—',
        Email:     user.email || '—',
        Phone:     user.phone || '—',
        Community: build ? `${build.name} · ${build.community}` : '—',
        Type:      type === 'request' ? 'Info Request' : 'New Registration',
        Time:      new Date().toLocaleString('en-CA', { timeZone: 'America/Toronto' }),
      }),
    });
  } catch (e) {
    console.warn('[lead] notification failed:', e);
  }
}

// ─────────────────────────────────────────────
// requestInfo — entry point from sidebar button
// ─────────────────────────────────────────────
export async function requestInfo(build) {
  if (isRegistered()) {
    markRequested(build.id);
    window.dispatchEvent(new CustomEvent('request-sent', { detail: { buildId: build.id } }));
    sendNotification(getUser(), build, 'request'); // fire-and-forget
    return;
  }
  _pendingBuild = build;
  openLeadModal('request');
}

// ─────────────────────────────────────────────
// initLeadModal — called once at app start
// ─────────────────────────────────────────────
export function initLeadModal() {
  document.getElementById('lead-modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'lead-modal-backdrop') {
      document.getElementById('lead-modal-backdrop').classList.remove('open');
      _pendingBuild = null;
    }
  });
}

// ─────────────────────────────────────────────
// openLeadModal
// ─────────────────────────────────────────────
export function openLeadModal(mode = 'register') {
  _renderModal(mode);
  document.getElementById('lead-modal-backdrop').classList.add('open');
  setTimeout(() => document.getElementById('lead-name')?.focus(), 80);
}

// ─────────────────────────────────────────────
// Render modal HTML
// ─────────────────────────────────────────────
function _renderModal(mode) {
  const isReq = mode === 'request';
  const cName = _pendingBuild?.name       || '';
  const cArea = _pendingBuild?.community  || '';

  document.getElementById('lead-modal').innerHTML = `
    ${isReq && cName ? `
      <div class="lead-community-badge">
        <span class="lead-badge-icon">📍</span>
        <strong>${esc(cName)}</strong>
        <span class="lead-badge-area">${esc(cArea)}</span>
      </div>` : ''}
    <h2>${isReq ? 'Request Info' : 'Unlock Pricing'}</h2>
    <p class="lead-subtitle">${isReq
      ? `Leave your details — an agent will follow up with pricing &amp; availability for <strong>${esc(cName)}</strong>.`
      : 'Enter your details to see real prices for all Ottawa new builds — free, no spam.'
    }</p>
    <div class="lead-field">
      <label for="lead-name">Name</label>
      <input type="text" id="lead-name" placeholder="Your name" autocomplete="name" />
    </div>
    <div class="lead-field">
      <label for="lead-email">Email <span class="lead-required">*</span></label>
      <input type="email" id="lead-email" placeholder="you@email.com" autocomplete="email" />
    </div>
    <div class="lead-field">
      <label for="lead-phone">Phone <span class="lead-optional">(optional)</span></label>
      <input type="tel" id="lead-phone" placeholder="613-555-0100" autocomplete="tel" />
    </div>
    <div class="lead-actions">
      <button class="lead-btn-cancel" id="lead-modal-close">Cancel</button>
      <button class="lead-btn-submit" id="lead-modal-submit">
        ${isReq ? 'Send Request →' : 'Get Prices →'}
      </button>
    </div>`;

  document.getElementById('lead-modal-close').addEventListener('click', () => {
    document.getElementById('lead-modal-backdrop').classList.remove('open');
    _pendingBuild = null;
  });
  document.getElementById('lead-modal-submit').addEventListener('click', _handleSubmit);
  document.getElementById('lead-email').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _handleSubmit();
  });
}

// ─────────────────────────────────────────────
// Handle submit
// ─────────────────────────────────────────────
async function _handleSubmit() {
  const email = document.getElementById('lead-email')?.value.trim() || '';
  const name  = document.getElementById('lead-name')?.value.trim()  || '';
  const phone = document.getElementById('lead-phone')?.value.trim() || '';

  if (!email || !email.includes('@')) {
    const el = document.getElementById('lead-email');
    el.style.borderColor = '#e53935';
    el.focus();
    return;
  }

  const submitEl = document.getElementById('lead-modal-submit');
  if (submitEl) { submitEl.disabled = true; submitEl.textContent = 'Sending…'; }

  const user  = { name, email, phone, ts: new Date().toISOString() };
  const build = _pendingBuild;
  const type  = build ? 'request' : 'register';

  localStorage.setItem(LEAD_KEY, JSON.stringify(user));
  _unlocked = true;
  if (build) markRequested(build.id);

  await sendNotification(user, build, type);

  // Log lead to server (fire-and-forget — fails silently on static hosts)
  fetch('/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, email, phone,
      community: build ? `${build.name} · ${build.community}` : '—',
      type,
      ts: new Date().toISOString(),
    }),
  }).catch(() => {});

  // Success screen
  const successMsg = build
    ? `Price request for <strong>${esc(build.name)}</strong> sent.<br>You will receive a price sheet at your email.`
    : 'You are now registered. Prices are unlocked.';

  document.getElementById('lead-modal').innerHTML = `
    <div class="lead-success">
      <div class="lead-checkmark">✓</div>
      <h3>${build ? 'Request Sent!' : "You're In!"}</h3>
      <p>${successMsg}</p>
      <p class="lead-success-email">📧 ${esc(email)}</p>
    </div>`;

  const pendingId = build?.id;
  _pendingBuild = null;

  setTimeout(() => {
    document.getElementById('lead-modal-backdrop').classList.remove('open');
    if (pendingId) {
      window.dispatchEvent(new CustomEvent('request-sent', { detail: { buildId: pendingId } }));
    }
    window.dispatchEvent(new CustomEvent('lead-unlocked'));
  }, 2200);
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
