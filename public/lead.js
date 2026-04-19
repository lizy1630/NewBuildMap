/**
 * Lead capture & info-request system.
 *
 * Flow:
 *  1. "Unlock the Price" clicked on a community.
 *  2. Not registered → modal collects name + email (pre-filled from draft if returning).
 *  3. Submit → saves to localStorage, calls /api/leads (Cloudflare Worker).
 *  4. Worker saves to KV, sends user a confirmation email with PDF link (if available),
 *     and notifies agent — all via Resend.
 *  5. Already registered → request fires immediately, no modal.
 *  6. Same community revisited → button stays "✓ Sent".
 */

const LEAD_KEY     = 'nbm_lead';      // localStorage → { name, email, ts }
const REQ_KEY      = 'nbm_requests';  // localStorage → ['build-id', ...]
const DRAFT_KEY    = 'nbm_draft';     // localStorage → { name, email } — pre-fills next open
const VID_KEY      = 'nbm_vid';       // localStorage → persistent visitor UUID (one per browser)

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
// Visitor ID — persistent per browser
// ─────────────────────────────────────────────
function getVisitorId() {
  let vid = localStorage.getItem(VID_KEY);
  if (!vid) {
    vid = crypto.randomUUID();
    localStorage.setItem(VID_KEY, vid);
  }
  return vid;
}

// ─────────────────────────────────────────────
// Click tracking — one count per visitor per community
// ─────────────────────────────────────────────
function trackClick(build) {
  const vid = getVisitorId();

  // Only fire to server once per visitor per build (deduplicated in KV by key)
  fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vid,
      buildId:   build.id,
      buildName: build.name,
      community: build.community,
      ts:        new Date().toISOString(),
    }),
  }).catch(() => {});
}

export function getVisitorIdPublic() { return getVisitorId(); }

// ─────────────────────────────────────────────
// Draft helpers (pre-populate on re-open)
// ─────────────────────────────────────────────
function saveDraft(name, email) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ name, email })); } catch {}
}

function getDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch { return {}; }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}

// ─────────────────────────────────────────────
// requestInfo — entry point from sidebar button
// ─────────────────────────────────────────────
export async function requestInfo(build) {
  trackClick(build);

  if (isRegistered()) {
    markRequested(build.id);
    window.dispatchEvent(new CustomEvent('request-sent', { detail: { buildId: build.id } }));
    const user = getUser();
    fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:          user.name  || '—',
        email:         user.email || '—',
        buildId:       build.id,
        community:     `${build.name} · ${build.community}`,
        priceSheetUrl: build.latestPriceSheetUrl || null,
        type:          'request',
        clickStats:    getClickStats(),
        ts:            new Date().toISOString(),
      }),
    }).catch(() => {});
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
  // Focus email if draft already has a name (less friction), otherwise name
  const draft = getDraft();
  setTimeout(() => {
    const target = draft.name ? 'lead-email' : 'lead-name';
    document.getElementById(target)?.focus();
  }, 80);
}

// ─────────────────────────────────────────────
// Render modal HTML
// ─────────────────────────────────────────────
function _renderModal(mode) {
  const isReq  = mode === 'request';
  const cName  = _pendingBuild?.name      || '';
  const cArea  = _pendingBuild?.community || '';
  const draft  = getDraft();

  document.getElementById('lead-modal').innerHTML = `
    ${isReq && cName ? `
      <div class="lead-community-badge">
        <span class="lead-badge-icon">📍</span>
        <strong>${esc(cName)}</strong>
        <span class="lead-badge-area">${esc(cArea)}</span>
      </div>` : ''}
    <h2>${isReq ? 'Unlock the Price' : 'Unlock Pricing'}</h2>
    <p class="lead-subtitle">${isReq
      ? `Pricing for <strong>${esc(cName)}</strong> will be sent to your email shortly.`
      : 'Enter your details to see real prices for all Ottawa new builds — free, no spam.'
    }</p>
    <div class="lead-field">
      <label for="lead-name">Name</label>
      <input type="text" id="lead-name" placeholder="Your name" autocomplete="name" value="${esc(draft.name || '')}" />
    </div>
    <div class="lead-field">
      <label for="lead-email">Email <span class="lead-required">*</span></label>
      <input type="email" id="lead-email" placeholder="you@email.com" autocomplete="email" value="${esc(draft.email || '')}" />
    </div>
    <div class="lead-actions">
      <button class="lead-btn-cancel" id="lead-modal-close">Cancel</button>
      <button class="lead-btn-submit" id="lead-modal-submit">
        ${isReq ? 'Unlock the price' : 'Get Prices →'}
      </button>
    </div>`;

  // Save draft on every keystroke so next open is pre-filled
  const saveDraftNow = () => saveDraft(
    document.getElementById('lead-name')?.value  || '',
    document.getElementById('lead-email')?.value || '',
  );
  document.getElementById('lead-name').addEventListener('input',  saveDraftNow);
  document.getElementById('lead-email').addEventListener('input', saveDraftNow);

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

  if (!email || !email.includes('@')) {
    const el = document.getElementById('lead-email');
    el.style.borderColor = '#e53935';
    el.focus();
    return;
  }

  const submitEl = document.getElementById('lead-modal-submit');
  if (submitEl) { submitEl.disabled = true; submitEl.textContent = 'Sending…'; }

  const user  = { name, email, ts: new Date().toISOString() };
  const build = _pendingBuild;
  const type  = build ? 'request' : 'register';

  localStorage.setItem(LEAD_KEY, JSON.stringify(user));
  clearDraft();
  _unlocked = true;
  if (build) markRequested(build.id);

  // Send to Cloudflare Worker — handles KV storage + Resend emails to user + agent
  fetch('/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      email,
      buildId:       build?.id       || '—',
      community:     build ? `${build.name} · ${build.community}` : '—',
      priceSheetUrl: build?.latestPriceSheetUrl || null,
      type,
      clickStats:    getClickStats(),
      ts:            new Date().toISOString(),
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
