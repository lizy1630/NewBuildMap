/**
 * Cloudflare Pages Function — GET /api/stats
 *
 * Returns aggregate click + lead stats from KV.
 * Protected by STATS_TOKEN env var — pass as ?token=xxx
 *
 * Response shape:
 * {
 *   clicks: [{ buildId, buildName, community, total, unique }],  // sorted by total desc
 *   leads:  [{ name, email, community, ts }],
 *   summary: { totalClicks, totalUniqueVisitors, totalLeads }
 * }
 */

export async function onRequestGet({ request, env }) {
  // Auth check
  const token = new URL(request.url).searchParams.get('token');
  if (!env.STATS_TOKEN || token !== env.STATS_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!env.LEADS_KV) {
    return new Response(JSON.stringify({ error: 'KV not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Fetch all click keys ──────────────────────────────────────────────────
  const clickMap = {}; // buildId → { buildName, community, total, vids: Set }

  let clickCursor = null;
  do {
    const list = await env.LEADS_KV.list({ prefix: 'click:', limit: 1000, cursor: clickCursor });
    for (const { name: key } of list.keys) {
      const val = await env.LEADS_KV.get(key, 'json');
      if (!val) continue;
      const { buildId, buildName, community, vid } = val;
      if (!clickMap[buildId]) {
        clickMap[buildId] = { buildId, buildName: buildName || buildId, community: community || '', total: 0, vids: new Set() };
      }
      clickMap[buildId].total++;
      if (vid && vid !== 'anon') clickMap[buildId].vids.add(vid);
    }
    clickCursor = list.list_complete ? null : list.cursor;
  } while (clickCursor);

  const clicks = Object.values(clickMap)
    .map(({ vids, ...rest }) => ({ ...rest, unique: vids.size }))
    .sort((a, b) => b.total - a.total);

  // ── Fetch all lead keys ───────────────────────────────────────────────────
  const leads = [];
  let leadCursor = null;
  do {
    const list = await env.LEADS_KV.list({ prefix: 'lead:', limit: 1000, cursor: leadCursor });
    for (const { name: key } of list.keys) {
      const val = await env.LEADS_KV.get(key, 'json');
      if (val) leads.push(val);
    }
    leadCursor = list.list_complete ? null : list.cursor;
  } while (leadCursor);

  leads.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const totalUniqueVisitors = new Set(
    Object.values(clickMap).flatMap(c => [...c.vids])
  ).size;

  return new Response(JSON.stringify({
    clicks,
    leads,
    summary: {
      totalClicks:         clicks.reduce((s, c) => s + c.total, 0),
      totalUniqueVisitors,
      totalLeads:          leads.length,
    },
  }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
