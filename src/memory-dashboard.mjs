#!/usr/bin/env node

import http from 'node:http';
import { URL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.OC_MEMORY_DATABASE_URL;
const host = process.env.OC_MEMORY_DASHBOARD_HOST ?? '127.0.0.1';
const port = Number(process.env.OC_MEMORY_DASHBOARD_PORT ?? 18765);

if (!connectionString) {
  console.error('OC_MEMORY_DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString, max: 4 });

function json(res, value, status = 200) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function html(res, value) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(value);
}

function notFound(res) {
  json(res, { error: 'not found' }, 404);
}

function numberParam(searchParams, name, fallback, min, max) {
  const raw = searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function listMemories(searchParams) {
  const query = searchParams.get('q')?.trim();
  const namespace = searchParams.get('namespace')?.trim();
  const category = searchParams.get('category')?.trim();
  const status = searchParams.get('status')?.trim();
  const limit = numberParam(searchParams, 'limit', 100, 1, 500);
  const offset = numberParam(searchParams, 'offset', 0, 0, 100000);

  const params = [];
  const where = ['true'];

  if (query) {
    params.push(query);
    const idx = params.length;
    where.push(`(content ilike '%' || $${idx} || '%' or key ilike '%' || $${idx} || '%' or namespace ilike '%' || $${idx} || '%')`);
  }

  if (namespace) {
    params.push(namespace);
    where.push(`namespace = $${params.length}`);
  }

  if (category) {
    params.push(category);
    where.push(`category = $${params.length}`);
  }

  if (status === 'active') where.push('(expires_at is null or expires_at > now())');
  if (status === 'expired') where.push('expires_at is not null and expires_at <= now()');
  if (status === 'permanent') where.push('expires_at is null');
  if (status === 'expiring') where.push("expires_at is not null and expires_at > now() and expires_at <= now() + interval '14 days'");

  params.push(limit, offset);
  const result = await pool.query(`
    select
      id,
      namespace,
      category,
      key,
      content,
      metadata,
      importance,
      confidence,
      created_at,
      updated_at,
      last_accessed_at,
      access_count,
      last_confirmed_at,
      expires_at,
      case
        when expires_at is null then null
        else extract(epoch from (expires_at - now())) / 86400
      end as days_until_expiry,
      case
        when expires_at is not null and expires_at <= now() then 'expired'
        when expires_at is not null and expires_at <= now() + interval '14 days' then 'expiring'
        when expires_at is null then 'permanent'
        else 'active'
      end as memory_status
    from agent_memories
    where ${where.join(' and ')}
    order by
      case
        when expires_at is not null and expires_at <= now() then 0
        when expires_at is not null and expires_at <= now() + interval '14 days' then 1
        else 2
      end,
      importance desc,
      updated_at desc
    limit $${params.length - 1}
    offset $${params.length}
  `, params);

  return result.rows;
}

async function stats() {
  const [summary, byCategory, byNamespace, expiry, usage] = await Promise.all([
    pool.query(`
      select
        count(*)::int as total,
        count(*) filter (where expires_at is null)::int as permanent,
        count(*) filter (where expires_at is not null and expires_at > now())::int as active_with_ttl,
        count(*) filter (where expires_at is not null and expires_at <= now())::int as expired,
        count(*) filter (where expires_at is not null and expires_at > now() and expires_at <= now() + interval '14 days')::int as expiring_soon,
        coalesce(sum(access_count), 0)::int as total_accesses,
        count(*) filter (where access_count > 0)::int as used_memories,
        round(avg(access_count)::numeric, 2) as avg_access_count
      from agent_memories
    `),
    pool.query(`
      select category, count(*)::int as count, coalesce(sum(access_count), 0)::int as accesses
      from agent_memories
      group by category
      order by count desc, category asc
    `),
    pool.query(`
      select namespace, count(*)::int as count, coalesce(sum(access_count), 0)::int as accesses
      from agent_memories
      group by namespace
      order by count desc, namespace asc
    `),
    pool.query(`
      select
        count(*) filter (where expires_at is not null and expires_at <= now())::int as expired,
        count(*) filter (where expires_at is not null and expires_at > now() and expires_at <= now() + interval '7 days')::int as within_7_days,
        count(*) filter (where expires_at is not null and expires_at > now() and expires_at <= now() + interval '14 days')::int as within_14_days,
        count(*) filter (where expires_at is not null and expires_at > now() and expires_at <= now() + interval '30 days')::int as within_30_days
      from agent_memories
    `),
    pool.query(`
      select id, namespace, category, key, content, access_count, last_accessed_at, updated_at
      from agent_memories
      where expires_at is null or expires_at > now()
      order by access_count desc, last_accessed_at desc nulls last
      limit 10
    `)
  ]);

  const s = summary.rows[0];
  const total = Number(s.total || 0);
  const used = Number(s.used_memories || 0);

  return {
    summary: {
      ...s,
      usage_rate: total === 0 ? 0 : Number((used / total).toFixed(4))
    },
    by_category: byCategory.rows,
    by_namespace: byNamespace.rows,
    expiry: expiry.rows[0],
    top_used: usage.rows
  };
}

async function expiring(searchParams) {
  const days = numberParam(searchParams, 'days', 14, 1, 365);
  const limit = numberParam(searchParams, 'limit', 100, 1, 500);

  const result = await pool.query(`
    select
      id,
      namespace,
      category,
      key,
      content,
      importance,
      confidence,
      access_count,
      last_accessed_at,
      updated_at,
      expires_at,
      extract(epoch from (expires_at - now())) / 86400 as days_until_expiry
    from agent_memories
    where expires_at is not null
      and expires_at > now()
      and expires_at <= now() + ($1::text || ' days')::interval
    order by expires_at asc, importance desc
    limit $2
  `, [days, limit]);

  return result.rows;
}

async function cleanupCandidates(searchParams) {
  const staleDays = numberParam(searchParams, 'stale_days', 30, 7, 365);
  const lowImportanceMax = numberParam(searchParams, 'low_importance_max', 2, 0, 5);
  const limit = numberParam(searchParams, 'limit', 100, 1, 500);

  const result = await pool.query(`
    select
      id,
      namespace,
      category,
      key,
      content,
      importance,
      confidence,
      access_count,
      last_accessed_at,
      updated_at,
      expires_at,
      case
        when expires_at is not null and expires_at <= now() then 'expired'
        else 'stale_low_value'
      end as reason
    from agent_memories
    where expires_at < now()
       or (
        category in ('note', 'tool')
        and importance <= $1
        and updated_at < now() - ($2::text || ' days')::interval
        and (last_accessed_at is null or last_accessed_at < now() - ($2::text || ' days')::interval)
      )
    order by importance asc, updated_at asc
    limit $3
  `, [lowImportanceMax, staleDays, limit]);

  return result.rows;
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenCode Memory Dashboard</title>
  <style>
    :root { color-scheme: light dark; --gap: 14px; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b1020; color: #e7ecff; }
    header { padding: 22px 28px; background: linear-gradient(135deg, #1d2b64, #5f2c82); border-bottom: 1px solid rgba(255,255,255,.16); }
    h1 { margin: 0 0 6px; font-size: 24px; }
    header p { margin: 0; opacity: .82; }
    main { padding: 20px 28px 40px; max-width: 1480px; margin: 0 auto; }
    .cards { display: grid; grid-template-columns: repeat(6, minmax(120px, 1fr)); gap: var(--gap); margin-bottom: 18px; }
    .card, .panel { background: rgba(255,255,255,.075); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; box-shadow: 0 12px 36px rgba(0,0,0,.18); }
    .card { padding: 14px; }
    .label { color: #aeb9e8; font-size: 12px; }
    .value { margin-top: 6px; font-size: 26px; font-weight: 700; }
    .toolbar { display: grid; grid-template-columns: 1.7fr 1fr 1fr 1fr auto; gap: 10px; margin: 14px 0; }
    input, select, button { border: 1px solid rgba(255,255,255,.16); border-radius: 10px; background: rgba(255,255,255,.08); color: #e7ecff; padding: 10px 12px; font: inherit; }
    button { cursor: pointer; background: #6d5dfc; border-color: #8d81ff; font-weight: 650; }
    button.secondary { background: rgba(255,255,255,.08); }
    .grid { display: grid; grid-template-columns: 1fr 360px; gap: var(--gap); align-items: start; }
    .panel { padding: 14px; overflow: hidden; }
    .panel h2 { margin: 0 0 12px; font-size: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 9px 8px; border-bottom: 1px solid rgba(255,255,255,.1); vertical-align: top; text-align: left; }
    th { color: #aeb9e8; font-weight: 650; position: sticky; top: 0; background: #151b33; }
    .content { max-width: 620px; white-space: pre-wrap; word-break: break-word; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: rgba(255,255,255,.1); }
    .expired { background: rgba(255, 93, 93, .22); color: #ffb7b7; }
    .expiring { background: rgba(255, 188, 66, .22); color: #ffd88d; }
    .permanent { background: rgba(82, 211, 153, .18); color: #a6f4cf; }
    .active { background: rgba(105, 160, 255, .18); color: #bdd4ff; }
    .side-list { display: grid; gap: 10px; }
    .mini { padding: 10px; border-radius: 10px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08); }
    .mini-title { font-weight: 700; margin-bottom: 4px; }
    .muted { color: #aeb9e8; }
    .bar { height: 8px; border-radius: 999px; background: rgba(255,255,255,.1); overflow: hidden; margin-top: 8px; }
    .bar > div { height: 100%; background: linear-gradient(90deg, #52d399, #6d5dfc); }
    .rank-list { display: grid; gap: 10px; }
    .rank-card { position: relative; display: grid; grid-template-columns: 42px 1fr; gap: 10px; padding: 12px; border-radius: 14px; background: linear-gradient(135deg, rgba(109,93,252,.20), rgba(82,211,153,.08)); border: 1px solid rgba(255,255,255,.12); overflow: hidden; }
    .rank-card::after { content: ''; position: absolute; inset: auto 0 0 0; height: 3px; background: linear-gradient(90deg, #52d399, #6d5dfc); opacity: .8; }
    .rank-badge { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 12px; background: rgba(255,255,255,.12); color: #fff; font-weight: 800; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12); }
    .rank-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin-bottom: 4px; }
    .rank-key { font-weight: 800; word-break: break-word; }
    .rank-count { flex: 0 0 auto; color: #a6f4cf; font-size: 12px; font-weight: 800; }
    .rank-meta { font-size: 12px; color: #aeb9e8; margin-bottom: 8px; }
    .rank-text { font-size: 13px; line-height: 1.35; color: #eef2ff; word-break: break-word; }
    .rank-meter { height: 6px; border-radius: 999px; background: rgba(255,255,255,.10); overflow: hidden; margin-top: 10px; }
    .rank-meter > div { height: 100%; border-radius: inherit; background: linear-gradient(90deg, #52d399, #8d81ff); }
    @media (max-width: 1000px) { .cards { grid-template-columns: repeat(2, 1fr); } .grid, .toolbar { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>OpenCode Memory Dashboard</h1>
    <p>查看记忆内容、使用率、即将遗忘和清理候选。默认仅监听 127.0.0.1。</p>
  </header>
  <main>
    <section class="cards" id="cards"></section>

    <section class="toolbar">
      <input id="q" placeholder="搜索 content/key/namespace" />
      <input id="namespace" placeholder="namespace，如 global" />
      <select id="category"><option value="">全部 category</option><option>profile</option><option>preference</option><option>project</option><option>decision</option><option>lesson</option><option>note</option><option>tool</option></select>
      <select id="status"><option value="active">未过期</option><option value="">全部</option><option value="permanent">永久</option><option value="expiring">14 天内遗忘</option><option value="expired">已过期</option></select>
      <button id="refresh">刷新</button>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>记忆列表</h2>
        <div style="overflow:auto; max-height: 760px;">
          <table>
            <thead><tr><th>ID</th><th>Scope</th><th>Key</th><th>Content</th><th>Usage</th><th>Expiry</th></tr></thead>
            <tbody id="rows"></tbody>
          </table>
        </div>
      </div>
      <aside class="side-list">
        <div class="panel">
          <h2>快要遗忘</h2>
          <div id="expiring"></div>
        </div>
        <div class="panel">
          <h2>清理候选</h2>
          <div id="cleanup"></div>
        </div>
        <div class="panel">
          <h2>Top 使用</h2>
          <div id="topUsed"></div>
        </div>
      </aside>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
    const fmtDate = (s) => s ? new Date(s).toLocaleString() : '永久';
    const daysText = (n) => n === null || n === undefined ? '永久' : Number(n) < 0 ? '已过期' : Number(n).toFixed(1) + ' 天';
    async function get(path) { const r = await fetch(path); if (!r.ok) throw new Error(await r.text()); return r.json(); }

    function card(label, value, sub = '') {
      return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div><div class="muted">' + esc(sub) + '</div></div>';
    }

    function mini(m) {
      return '<div class="mini"><div class="mini-title">#' + esc(m.id) + ' · ' + esc(m.key || '(no key)') + '</div><div class="muted">' + esc(m.namespace) + ' / ' + esc(m.category) + '</div><div>' + esc(String(m.content || '').slice(0, 180)) + '</div><div class="muted">访问 ' + esc(m.access_count || 0) + ' · 过期 ' + esc(daysText(m.days_until_expiry)) + '</div></div>';
    }

    function topUsedCard(m, index, maxAccess) {
      const percent = maxAccess <= 0 ? 0 : Math.max(6, Math.round((Number(m.access_count || 0) / maxAccess) * 100));
      return '<div class="rank-card">'
        + '<div class="rank-badge">' + esc(index + 1) + '</div>'
        + '<div>'
        + '<div class="rank-head"><div class="rank-key">' + esc(m.key || '(no key)') + '</div><div class="rank-count">' + esc(m.access_count || 0) + ' 次</div></div>'
        + '<div class="rank-meta">#' + esc(m.id) + ' · ' + esc(m.namespace) + ' / ' + esc(m.category) + '</div>'
        + '<div class="rank-text">' + esc(String(m.content || '').slice(0, 150)) + '</div>'
        + '<div class="rank-meter"><div style="width:' + percent + '%"></div></div>'
        + '</div>'
        + '</div>';
    }

    async function load() {
      const params = new URLSearchParams();
      for (const id of ['q', 'namespace', 'category', 'status']) if ($(id).value) params.set(id, $(id).value);
      params.set('limit', '200');

      const [stats, memories, expiring, cleanup] = await Promise.all([
        get('/api/stats'),
        get('/api/memories?' + params.toString()),
        get('/api/expiring?days=14&limit=20'),
        get('/api/cleanup-candidates?limit=20')
      ]);

      const s = stats.summary;
      $('cards').innerHTML = [
        card('总记忆', s.total),
        card('使用率', Math.round((s.usage_rate || 0) * 100) + '%', '访问过 / 总数'),
        card('总访问', s.total_accesses),
        card('永久', s.permanent),
        card('14 天内遗忘', s.expiring_soon),
        card('已过期', s.expired)
      ].join('');

      $('rows').innerHTML = memories.map(m => {
        const status = m.memory_status || 'active';
        return '<tr>'
          + '<td>#' + esc(m.id) + '</td>'
          + '<td><span class="pill">' + esc(m.namespace) + '</span><br><span class="muted">' + esc(m.category) + '</span></td>'
          + '<td>' + esc(m.key || '') + '<br><span class="muted">重要 ' + esc(m.importance) + ' · 置信 ' + esc(m.confidence) + '</span></td>'
          + '<td class="content">' + esc(m.content) + '</td>'
          + '<td>访问 ' + esc(m.access_count || 0) + '<br><span class="muted">' + esc(m.last_accessed_at ? fmtDate(m.last_accessed_at) : '未访问') + '</span></td>'
          + '<td><span class="pill ' + esc(status) + '">' + esc(status) + '</span><br>' + esc(daysText(m.days_until_expiry)) + '<br><span class="muted">' + esc(fmtDate(m.expires_at)) + '</span></td>'
          + '</tr>';
      }).join('');

      $('expiring').innerHTML = expiring.length ? expiring.map(mini).join('') : '<div class="muted">暂无 14 天内会遗忘的记忆</div>';
      $('cleanup').innerHTML = cleanup.length ? cleanup.map(m => mini({ ...m, days_until_expiry: m.expires_at ? (new Date(m.expires_at) - Date.now()) / 86400000 : null }) + '<div class="muted">原因：' + esc(m.reason) + '</div>').join('') : '<div class="muted">暂无清理候选</div>';
      const maxAccess = Math.max(0, ...stats.top_used.map(m => Number(m.access_count || 0)));
      $('topUsed').innerHTML = stats.top_used.length ? '<div class="rank-list">' + stats.top_used.map((m, index) => topUsedCard(m, index, maxAccess)).join('') + '</div>' : '<div class="muted">暂无使用记录</div>';
    }

    $('refresh').addEventListener('click', load);
    for (const id of ['q', 'namespace', 'category', 'status']) $(id).addEventListener('change', load);
    $('q').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
    load().catch(err => { document.body.innerHTML = '<pre style="padding:24px;color:#ffb7b7">' + esc(err.stack || err) + '</pre>'; });
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    if (url.pathname === '/') return html(res, page);
    if (url.pathname === '/api/health') return json(res, { ok: true });
    if (url.pathname === '/api/stats') return json(res, await stats());
    if (url.pathname === '/api/memories') return json(res, await listMemories(url.searchParams));
    if (url.pathname === '/api/expiring') return json(res, await expiring(url.searchParams));
    if (url.pathname === '/api/cleanup-candidates') return json(res, await cleanupCandidates(url.searchParams));

    return notFound(res);
  } catch (error) {
    return json(res, { error: error.message, stack: error.stack }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`OpenCode memory dashboard: http://${host}:${port}`);
});
