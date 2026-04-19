/**
 * Cloudflare Pages Function — POST /api/track
 *
 * Stores every click event. Key includes timestamp so each click is a separate record.
 * Stats endpoint counts:
 *   - total clicks per build  (all records)
 *   - unique visitors per build (distinct vid values)
 *
 * KV key: click:{buildId}:{vid}:{ts}
 */

export async function onRequestPost({ request, env }) {
  try {
    const event = await request.json();
    if (env.LEADS_KV) {
      const ts  = event.ts  || new Date().toISOString();
      const bid = event.buildId || 'unknown';
      const vid = event.vid     || 'anon';
      const key = `click:${bid}:${vid}:${ts}`;
      await env.LEADS_KV.put(key, JSON.stringify({
        vid,
        buildId:   bid,
        buildName: event.buildName || '',
        community: event.community || '',
        ts,
      }), { expirationTtl: 60 * 60 * 24 * 90 }); // 90 days
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
