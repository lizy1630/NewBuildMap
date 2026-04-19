/**
 * Cloudflare Pages Function — POST /api/leads
 *
 * 1. Saves lead to KV (LEADS_KV binding)
 * 2. Sends user a confirmation email with price sheet link (via Resend)
 * 3. Notifies agent
 *
 * Required env vars (set in Cloudflare Pages → Settings → Environment variables):
 *   RESEND_API_KEY   — from resend.com (free tier: 3,000 emails/month)
 *   FROM_EMAIL       — e.g. "Ottawa New Builds <hello@newbuildmap.ca>"
 *                      (must be a verified domain in Resend)
 */

const AGENT_EMAIL = 'lizy1630@gmail.com';
const SITE_URL    = 'https://newbuildmap.ca';

export async function onRequestPost({ request, env }) {
  try {
    const lead = await request.json();

    const entry = {
      name:              lead.name      || '—',
      email:             lead.email     || '—',
      community:         lead.community || '—',
      buildId:           lead.buildId   || '—',
      type:              lead.type      || 'request',
      priceSheetUrl:     lead.priceSheetUrl || null,
      clickStats:        lead.clickStats || {},
      ts:                lead.ts        || new Date().toISOString(),
      localTime:         new Date(lead.ts || Date.now())
        .toLocaleString('en-CA', { timeZone: 'America/Toronto' }),
    };

    // 1. Store in KV
    if (env.LEADS_KV) {
      const key = `lead:${entry.ts}:${entry.email}`;
      await env.LEADS_KV.put(key, JSON.stringify(entry));
    }

    // 2. Send emails if Resend is configured
    if (env.RESEND_API_KEY && entry.email !== '—') {
      const from = env.FROM_EMAIL || 'Ottawa New Builds <hello@newbuildmap.ca>';
      await Promise.all([
        sendUserEmail(env.RESEND_API_KEY, from, entry),
        sendAgentEmail(env.RESEND_API_KEY, from, entry),
      ]);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ── User confirmation email ──────────────────────────────────────────────────
async function sendUserEmail(apiKey, from, entry) {
  const hasPdf = !!entry.priceSheetUrl;
  const pdfLink = hasPdf ? `${SITE_URL}${entry.priceSheetUrl}` : null;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
    <div style="background:#0a0a0f;padding:24px 28px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="width:10px;height:10px;border-radius:50%;background:#00d4ff;"></div>
        <span style="color:#fff;font-weight:700;font-size:15px;">Ottawa New Builds Map</span>
      </div>
    </div>
    <div style="padding:28px;">
      <h2 style="margin:0 0 8px;font-size:20px;color:#0a0a18;">
        ${hasPdf ? 'Your price sheet is ready' : 'We received your request'}
      </h2>
      <p style="margin:0 0 20px;color:#505070;font-size:14px;line-height:1.6;">
        ${entry.name ? `Hi ${entry.name},<br><br>` : ''}
        ${hasPdf
          ? `The price sheet for <strong>${entry.community}</strong> is attached below. Click the button to view or download it.`
          : `Thanks for your interest in <strong>${entry.community}</strong>. An agent will follow up with pricing and availability shortly.`
        }
      </p>
      ${hasPdf ? `
      <div style="text-align:center;margin:24px 0;">
        <a href="${pdfLink}"
           style="display:inline-block;background:#0099cc;color:#fff;padding:13px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">
          View Price Sheet →
        </a>
        <p style="margin:10px 0 0;font-size:12px;color:#8080a0;">
          Or copy this link: <a href="${pdfLink}" style="color:#0099cc;">${pdfLink}</a>
        </p>
      </div>` : ''}
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
      <p style="margin:0;font-size:12px;color:#8080a0;line-height:1.6;">
        Explore all Ottawa new build communities on the map:<br>
        <a href="${SITE_URL}" style="color:#0099cc;">${SITE_URL}</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  return resendSend(apiKey, {
    from,
    to:      [entry.email],
    subject: hasPdf
      ? `Your price sheet — ${entry.community} | Ottawa New Builds`
      : `Price request received — ${entry.community} | Ottawa New Builds`,
    html,
  });
}

// ── Agent notification email ─────────────────────────────────────────────────
async function sendAgentEmail(apiKey, from, entry) {
  const clicks   = entry.clickStats?.byBuild?.[entry.buildId] || 1;
  const pdfLink  = entry.priceSheetUrl ? `${SITE_URL}${entry.priceSheetUrl}` : '—';

  const html = `
<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;color:#111;">
  <h3 style="margin:0 0 16px;">[NewBuildMap] Price Request — ${entry.community}</h3>
  <table style="border-collapse:collapse;font-size:14px;">
    <tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap;">Name</td><td><strong>${entry.name}</strong></td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666;">Email</td><td><a href="mailto:${entry.email}">${entry.email}</a></td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666;">Community</td><td>${entry.community}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666;">Price Sheet</td><td>${entry.priceSheetUrl ? `<a href="${pdfLink}">Download PDF</a>` : 'Not available (sent agent follow-up)'}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666;">Button clicks</td><td>${clicks}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666;">Time</td><td>${entry.localTime}</td></tr>
  </table>
</body></html>`;

  return resendSend(apiKey, {
    from,
    to:      [AGENT_EMAIL],
    subject: `[NewBuildMap] Price Request — ${entry.community}`,
    html,
  });
}

// ── Resend API helper ────────────────────────────────────────────────────────
async function resendSend(apiKey, payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    console.warn('[leads] Resend error:', err);
  }
}

// ── CORS preflight ───────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
