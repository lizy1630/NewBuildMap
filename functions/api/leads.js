/**
 * Cloudflare Pages Function — POST /api/leads
 *
 * Stores every lead submission in Cloudflare KV (binding: LEADS_KV).
 * Returns { ok: true } so the front-end knows it was received.
 *
 * KV key format:  lead:<ISO-timestamp>:<email>
 * KV value:       JSON stringified lead object
 */

export async function onRequestPost({ request, env }) {
  try {
    const lead = await request.json();

    const entry = {
      name:      lead.name      || '—',
      email:     lead.email     || '—',
      phone:     lead.phone     || '—',
      community: lead.community || '—',
      type:      lead.type      || 'unknown',
      ts:        lead.ts        || new Date().toISOString(),
      localTime: new Date(lead.ts || Date.now())
        .toLocaleString('en-CA', { timeZone: 'America/Toronto' }),
    };

    // Store in KV if binding exists
    if (env.LEADS_KV) {
      const key = `lead:${entry.ts}:${entry.email}`;
      await env.LEADS_KV.put(key, JSON.stringify(entry));
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

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
