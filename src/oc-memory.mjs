#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.OC_MEMORY_DATABASE_URL;

if (!connectionString) {
  console.error('OC_MEMORY_DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString, max: 4 });

const categoryTtlDays = {
  profile: null,
  preference: null,
  project: 180,
  decision: null,
  lesson: 180,
  note: 30,
  tool: 7
};

function defaultExpiresAt(category) {
  const days = categoryTtlDays[category] ?? 30;
  if (days === null) return null;

  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

async function initializeSchema() {
  await pool.query(`
    create table if not exists agent_memories (
      id bigserial primary key,
      namespace text not null default 'global',
      category text not null default 'note',
      key text,
      content text not null,
      metadata jsonb not null default '{}'::jsonb,
      importance integer not null default 0,
      confidence double precision not null default 1.0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_accessed_at timestamptz,
      access_count integer not null default 0,
      last_confirmed_at timestamptz,
      expires_at timestamptz
    );

    alter table agent_memories
      add column if not exists last_accessed_at timestamptz,
      add column if not exists access_count integer not null default 0,
      add column if not exists last_confirmed_at timestamptz;

    create unique index if not exists agent_memories_namespace_category_key_idx
      on agent_memories (namespace, category, key)
      where key is not null;

    create index if not exists agent_memories_namespace_category_idx
      on agent_memories (namespace, category);

    create index if not exists agent_memories_updated_at_idx
      on agent_memories (updated_at desc);

    create index if not exists agent_memories_last_confirmed_at_idx
      on agent_memories (last_confirmed_at asc nulls first);

    create index if not exists agent_memories_content_fts_idx
      on agent_memories using gin (to_tsvector('simple', content));

    create index if not exists agent_memories_metadata_idx
      on agent_memories using gin (metadata);
  `);
}

function rowToText(row) {
  return JSON.stringify(row, null, 2);
}

const server = new McpServer({
  name: 'oc-memory',
  version: '1.0.0'
});

server.registerTool('memory_add', {
  description: 'Add or upsert a long-term OpenCode agent memory. Use for durable user preferences, project facts, decisions, and stable lessons learned. If key is provided, namespace+category+key is upserted. If expires_at is omitted, a category-based default TTL is applied: profile/preference/decision permanent, project/lesson 180d, note 30d, tool 7d.',
  inputSchema: {
    content: z.string().min(1).describe('Memory text to store'),
    namespace: z.string().default('global').describe('Scope such as global, user, project:<name>, repo:<path>'),
    category: z.string().default('note').describe('profile, preference, project, decision, lesson, note, tool'),
    key: z.string().optional().describe('Stable unique key for upsert/update, e.g. response_language'),
    metadata: z.record(z.string(), z.unknown()).default({}).describe('Additional JSON metadata'),
    importance: z.number().int().min(0).max(10).default(3),
    confidence: z.number().min(0).max(1).default(1),
    expires_at: z.string().datetime().nullable().optional().describe('Optional ISO timestamp when memory expires. Omit to use category default TTL; pass null for permanent.')
  }
}, async ({ content, namespace, category, key, metadata, importance, confidence, expires_at }) => {
  const effectiveExpiresAt = expires_at === undefined ? defaultExpiresAt(category) : expires_at;
  const result = await pool.query(`
    insert into agent_memories (namespace, category, key, content, metadata, importance, confidence, expires_at)
    values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
    on conflict (namespace, category, key) where key is not null
    do update set
      content = excluded.content,
      metadata = excluded.metadata,
      importance = excluded.importance,
      confidence = excluded.confidence,
      expires_at = excluded.expires_at,
      updated_at = now()
    returning *
  `, [namespace, category, key ?? null, content, JSON.stringify(metadata ?? {}), importance, confidence, effectiveExpiresAt]);

  return { content: [{ type: 'text', text: rowToText(result.rows[0]) }] };
});

server.registerTool('memory_search', {
  description: 'Search OpenCode long-term memories by text and optional namespace/category. Returns non-expired memories ranked by importance and recency.',
  inputSchema: {
    query: z.string().optional().describe('Text query. If omitted, returns recent memories.'),
    namespace: z.string().optional().describe('Exact namespace filter'),
    category: z.string().optional().describe('Exact category filter'),
    limit: z.number().int().min(1).max(50).default(10)
  }
}, async ({ query, namespace, category, limit }) => {
  const params = [];
  const where = ['(expires_at is null or expires_at > now())'];

  if (namespace) {
    params.push(namespace);
    where.push(`namespace = $${params.length}`);
  }

  if (category) {
    params.push(category);
    where.push(`category = $${params.length}`);
  }

  if (query) {
    params.push(query);
    const idx = params.length;
    where.push(`(content ilike '%' || $${idx} || '%' or key ilike '%' || $${idx} || '%' or to_tsvector('simple', content) @@ plainto_tsquery('simple', $${idx}))`);
  }

  params.push(limit);
  const result = await pool.query(`
    select * from agent_memories
    where ${where.join(' and ')}
    order by importance desc, updated_at desc
    limit $${params.length}
  `, params);

  if (result.rows.length > 0) {
    await pool.query(
      'update agent_memories set last_accessed_at = now(), access_count = access_count + 1 where id = any($1::bigint[])',
      [result.rows.map(row => row.id)]
    );
  }

  return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
});

server.registerTool('memory_context_search', {
  description: 'Search memories across contextual scopes in priority order: repo:<repo_path> > project:<project> > global. Use near the start of coding tasks to load global preferences plus project/repo-specific conventions.',
  inputSchema: {
    query: z.string().optional().describe('Text query. If omitted, returns recent contextual memories.'),
    repo_path: z.string().optional().describe('Absolute repository path, used as namespace repo:<path>'),
    project: z.string().optional().describe('Project name, used as namespace project:<name>'),
    category: z.string().optional().describe('Optional category filter'),
    limit: z.number().int().min(1).max(50).default(10)
  }
}, async ({ query, repo_path, project, category, limit }) => {
  const scopes = [];

  if (repo_path) {
    scopes.push({ namespace: `repo:${repo_path}`, priority: 3 });
  }

  if (project) {
    scopes.push({ namespace: `project:${project}`, priority: 2 });
  }

  scopes.push({ namespace: 'global', priority: 1 });

  const params = [];
  const namespaceValues = scopes.map(scope => scope.namespace);
  params.push(namespaceValues);

  const priorityCases = scopes
    .map((scope, index) => `when namespace = ($1::text[])[${index + 1}] then ${scope.priority}`)
    .join(' ');

  const where = ['(expires_at is null or expires_at > now())', 'namespace = any($1::text[])'];

  if (category) {
    params.push(category);
    where.push(`category = $${params.length}`);
  }

  if (query) {
    params.push(query);
    const idx = params.length;
    where.push(`(content ilike '%' || $${idx} || '%' or key ilike '%' || $${idx} || '%' or to_tsvector('simple', content) @@ plainto_tsquery('simple', $${idx}))`);
  }

  params.push(limit);
  const result = await pool.query(`
    select *,
      case ${priorityCases} else 0 end as scope_priority
    from agent_memories
    where ${where.join(' and ')}
    order by scope_priority desc, importance desc, updated_at desc
    limit $${params.length}
  `, params);

  if (result.rows.length > 0) {
    await pool.query(
      'update agent_memories set last_accessed_at = now(), access_count = access_count + 1 where id = any($1::bigint[])',
      [result.rows.map(row => row.id)]
    );
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        searched_namespaces: namespaceValues,
        priority: 'repo > project > global',
        memories: result.rows
      }, null, 2)
    }]
  };
});

server.registerTool('memory_update', {
  description: 'Update an existing OpenCode memory by id.',
  inputSchema: {
    id: z.number().int().positive(),
    content: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    importance: z.number().int().min(0).max(10).optional(),
    confidence: z.number().min(0).max(1).optional(),
    last_confirmed_at: z.string().datetime().nullable().optional(),
    expires_at: z.string().datetime().nullable().optional()
  }
}, async ({ id, content, metadata, importance, confidence, last_confirmed_at, expires_at }) => {
  const result = await pool.query(`
    update agent_memories set
      content = coalesce($2, content),
      metadata = coalesce($3::jsonb, metadata),
      importance = coalesce($4, importance),
      confidence = coalesce($5, confidence),
      last_confirmed_at = case when $6::text = '__unchanged__' then last_confirmed_at else $6::timestamptz end,
      expires_at = case when $7::text = '__unchanged__' then expires_at else $7::timestamptz end,
      updated_at = now()
    where id = $1
    returning *
  `, [id, content ?? null, metadata === undefined ? null : JSON.stringify(metadata), importance ?? null, confidence ?? null, last_confirmed_at === undefined ? '__unchanged__' : last_confirmed_at, expires_at === undefined ? '__unchanged__' : expires_at]);

  return { content: [{ type: 'text', text: result.rows[0] ? rowToText(result.rows[0]) : 'Memory not found' }] };
});

server.registerTool('memory_delete', {
  description: 'Delete an OpenCode memory by id.',
  inputSchema: {
    id: z.number().int().positive()
  }
}, async ({ id }) => {
  const result = await pool.query('delete from agent_memories where id = $1 returning id', [id]);
  return { content: [{ type: 'text', text: result.rows[0] ? `Deleted memory ${id}` : 'Memory not found' }] };
});

server.registerTool('memory_list_categories', {
  description: 'List memory namespaces and categories with counts.',
  inputSchema: {}
}, async () => {
  const result = await pool.query(`
    select namespace, category, count(*)::int as count
    from agent_memories
    where expires_at is null or expires_at > now()
    group by namespace, category
    order by namespace, category
  `);
  return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
});

server.registerTool('memory_cleanup', {
  description: 'Forget expired and stale low-value memories. Deletes expired memories, plus low-importance note/tool memories that are old and rarely accessed.',
  inputSchema: {
    dry_run: z.boolean().default(true).describe('Preview deletions without deleting'),
    stale_days: z.number().int().min(7).max(365).default(30),
    low_importance_max: z.number().int().min(0).max(5).default(2),
    limit: z.number().int().min(1).max(200).default(50)
  }
}, async ({ dry_run, stale_days, low_importance_max, limit }) => {
  const result = await pool.query(`
    select * from agent_memories
    where expires_at < now()
       or (
        category in ('note', 'tool')
        and importance <= $1
        and updated_at < now() - ($2::text || ' days')::interval
        and (last_accessed_at is null or last_accessed_at < now() - ($2::text || ' days')::interval)
      )
    order by importance asc, updated_at asc
    limit $3
  `, [low_importance_max, stale_days, limit]);

  if (!dry_run && result.rows.length > 0) {
    await pool.query('delete from agent_memories where id = any($1::bigint[])', [result.rows.map(row => row.id)]);
  }

  return { content: [{ type: 'text', text: JSON.stringify({ dry_run, count: result.rows.length, memories: result.rows }, null, 2) }] };
});

server.registerTool('memory_review_candidates', {
  description: 'Return memories that should be occasionally reconfirmed with the user. If the user denies a memory, delete it with memory_delete or correct it with memory_update.',
  inputSchema: {
    namespace: z.string().optional(),
    category: z.string().optional(),
    older_than_days: z.number().int().min(7).max(365).default(90),
    limit: z.number().int().min(1).max(20).default(5)
  }
}, async ({ namespace, category, older_than_days, limit }) => {
  const params = [older_than_days];
  const where = [
    '(expires_at is null or expires_at > now())',
    "category in ('profile', 'preference', 'project', 'decision')",
    "(last_confirmed_at is null or last_confirmed_at < now() - ($1::text || ' days')::interval or confidence < 0.8)"
  ];

  if (namespace) {
    params.push(namespace);
    where.push(`namespace = $${params.length}`);
  }

  if (category) {
    params.push(category);
    where.push(`category = $${params.length}`);
  }

  params.push(limit);
  const result = await pool.query(`
    select * from agent_memories
    where ${where.join(' and ')}
    order by
      case when last_confirmed_at is null then 0 else 1 end,
      last_confirmed_at asc nulls first,
      updated_at asc
    limit $${params.length}
  `, params);

  return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
});

server.registerTool('memory_confirm', {
  description: 'Mark a memory as reconfirmed by the user.',
  inputSchema: {
    id: z.number().int().positive(),
    confidence: z.number().min(0).max(1).default(1)
  }
}, async ({ id, confidence }) => {
  const result = await pool.query(`
    update agent_memories
    set last_confirmed_at = now(), confidence = $2, updated_at = now()
    where id = $1
    returning *
  `, [id, confidence]);

  return { content: [{ type: 'text', text: result.rows[0] ? rowToText(result.rows[0]) : 'Memory not found' }] };
});

await initializeSchema();
const transport = new StdioServerTransport();
await server.connect(transport);
