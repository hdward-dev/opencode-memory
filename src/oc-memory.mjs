#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.OC_MEMORY_DATABASE_URL;
const embeddingApiKey = process.env.OC_MEMORY_EMBEDDING_API_KEY;
const embeddingModel = process.env.OC_MEMORY_EMBEDDING_MODEL;
const embeddingUrl = process.env.OC_MEMORY_EMBEDDING_URL
  ?? (embeddingApiKey && embeddingModel ? 'https://api.openai.com/v1/embeddings' : undefined);
const configuredEmbeddingDimensions = process.env.OC_MEMORY_EMBEDDING_DIMENSIONS
  ? Number.parseInt(process.env.OC_MEMORY_EMBEDDING_DIMENSIONS, 10)
  : undefined;
const embeddingTimeoutMs = Number.parseInt(process.env.OC_MEMORY_EMBEDDING_TIMEOUT_MS ?? '15000', 10);

if (!connectionString) {
  console.error('OC_MEMORY_DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString, max: 4 });

const embeddingConfig = {
  enabled: Boolean(embeddingUrl && embeddingApiKey && embeddingModel),
  url: embeddingUrl,
  apiKey: embeddingApiKey,
  model: embeddingModel,
  dimensions: Number.isInteger(configuredEmbeddingDimensions) && configuredEmbeddingDimensions > 0 ? configuredEmbeddingDimensions : undefined,
  timeoutMs: Number.isInteger(embeddingTimeoutMs) && embeddingTimeoutMs > 0 ? embeddingTimeoutMs : 15000
};

const embeddingState = {
  enabled: embeddingConfig.enabled,
  available: false,
  extensionAvailable: false,
  columnExists: false,
  columnDimensions: null,
  warning: embeddingConfig.enabled && !embeddingConfig.dimensions
    ? 'OC_MEMORY_EMBEDDING_DIMENSIONS not set; vector schema will be initialized after the first embedding is generated.'
    : null
};

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

  await refreshEmbeddingStatus();

  if (embeddingConfig.enabled && embeddingConfig.dimensions) {
    await ensureEmbeddingSchema(embeddingConfig.dimensions);
  }
}

async function refreshEmbeddingStatus() {
  try {
    const extension = await pool.query("select exists(select 1 from pg_extension where extname = 'vector') as exists");
    const column = await pool.query(`
      select a.atttypmod as dimensions
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where c.relname = 'agent_memories'
        and n.nspname = current_schema()
        and a.attname = 'embedding'
        and not a.attisdropped
    `);

    embeddingState.extensionAvailable = Boolean(extension.rows[0]?.exists);
    embeddingState.columnExists = column.rows.length > 0;
    embeddingState.columnDimensions = column.rows[0]?.dimensions > 0 ? Number(column.rows[0].dimensions) : null;
    embeddingState.available = embeddingConfig.enabled
      && embeddingState.extensionAvailable
      && embeddingState.columnExists
      && (!embeddingConfig.dimensions || embeddingState.columnDimensions === embeddingConfig.dimensions);
  } catch (error) {
    embeddingState.available = false;
    embeddingState.warning = `Could not inspect embedding schema: ${error.message}`;
  }
}

async function ensureEmbeddingSchema(dimensions) {
  if (!embeddingConfig.enabled || !Number.isInteger(dimensions) || dimensions <= 0) return false;

  if (embeddingState.columnExists && embeddingState.columnDimensions !== dimensions) {
    embeddingState.available = false;
    embeddingState.warning = `Existing agent_memories.embedding dimension (${embeddingState.columnDimensions}) does not match configured/generated dimension (${dimensions}); semantic search disabled until schema is reconciled.`;
    console.warn(`[oc-memory] ${embeddingState.warning}`);
    return false;
  }

  try {
    await pool.query('create extension if not exists vector');
    embeddingState.extensionAvailable = true;
  } catch (error) {
    embeddingState.extensionAvailable = false;
    embeddingState.available = false;
    embeddingState.warning = `pgvector extension unavailable; semantic search disabled: ${error.message}`;
    console.warn(`[oc-memory] ${embeddingState.warning}`);
    return false;
  }

  try {
    if (!embeddingState.columnExists) {
      await pool.query(`alter table agent_memories add column embedding vector(${dimensions})`);
    }
    embeddingConfig.dimensions = dimensions;
    await refreshEmbeddingStatus();
  } catch (error) {
    embeddingState.available = false;
    embeddingState.warning = `Could not add embedding column; semantic search disabled: ${error.message}`;
    console.warn(`[oc-memory] ${embeddingState.warning}`);
    return false;
  }

  try {
    await pool.query('create index if not exists agent_memories_embedding_hnsw_idx on agent_memories using hnsw (embedding vector_cosine_ops)');
  } catch (hnswError) {
    try {
      await pool.query('create index if not exists agent_memories_embedding_ivfflat_idx on agent_memories using ivfflat (embedding vector_cosine_ops) with (lists = 100)');
    } catch (ivfError) {
      console.warn(`[oc-memory] Could not create vector index; continuing without it: ${ivfError.message || hnswError.message}`);
    }
  }

  return embeddingState.available;
}

function memoryEmbeddingInput(row) {
  const metadata = row.metadata && Object.keys(row.metadata).length > 0
    ? `\nmetadata: ${JSON.stringify(row.metadata).slice(0, 500)}`
    : '';

  return [
    `namespace: ${row.namespace ?? 'global'}`,
    `category: ${row.category ?? 'note'}`,
    row.key ? `key: ${row.key}` : null,
    `content: ${String(row.content ?? '').slice(0, 4000)}`,
    metadata || null
  ].filter(Boolean).join('\n');
}

function vectorLiteral(values) {
  return `[${values.map(value => {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : '0';
  }).join(',')}]`;
}

async function generateEmbedding(input) {
  if (!embeddingConfig.enabled) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), embeddingConfig.timeoutMs);

  try {
    const body = {
      model: embeddingConfig.model,
      input
    };

    if (embeddingConfig.dimensions) body.dimensions = embeddingConfig.dimensions;

    const response = await fetch(embeddingConfig.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${embeddingConfig.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`embedding request failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    const json = await response.json();
    const embedding = json?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error('embedding response missing data[0].embedding');
    }

    if (!embeddingConfig.dimensions) {
      embeddingConfig.dimensions = embedding.length;
    }

    if (embeddingConfig.dimensions !== embedding.length) {
      throw new Error(`embedding dimension ${embedding.length} does not match expected ${embeddingConfig.dimensions}`);
    }

    await ensureEmbeddingSchema(embedding.length);
    return embedding;
  } catch (error) {
    embeddingState.warning = `Embedding generation failed; continuing without embedding: ${error.message}`;
    console.warn(`[oc-memory] ${embeddingState.warning}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeRow(row) {
  if (!row || !Object.prototype.hasOwnProperty.call(row, 'embedding')) return row;
  const { embedding, ...rest } = row;
  return rest;
}

function rowToText(row) {
  return JSON.stringify(sanitizeRow(row), null, 2);
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

  await updateMemoryEmbedding(result.rows[0]);

  return { content: [{ type: 'text', text: rowToText(result.rows[0]) }] };
});

async function updateMemoryEmbedding(row) {
  if (!row || !embeddingConfig.enabled) return false;
  const embedding = await generateEmbedding(memoryEmbeddingInput(row));
  if (!embedding || !embeddingState.available) return false;

  await pool.query(
    'update agent_memories set embedding = $2::vector where id = $1',
    [row.id, vectorLiteral(embedding)]
  );
  return true;
}

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

  return { content: [{ type: 'text', text: JSON.stringify(result.rows.map(sanitizeRow), null, 2) }] };
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
        memories: result.rows.map(sanitizeRow)
      }, null, 2)
    }]
  };
});

server.registerTool('memory_semantic_search', {
  description: 'Search memories by semantic similarity using optional pgvector embeddings. If repo_path/project are provided, searches repo > project > global contextual scopes. Falls back with a clear error when embeddings are not configured or unavailable.',
  inputSchema: {
    query: z.string().min(1).describe('Semantic search query'),
    namespace: z.string().optional().describe('Exact namespace filter; ignored when repo_path/project contextual scopes are used'),
    category: z.string().optional().describe('Exact category filter'),
    repo_path: z.string().optional().describe('Absolute repository path, used as namespace repo:<path>'),
    project: z.string().optional().describe('Project name, used as namespace project:<name>'),
    limit: z.number().int().min(1).max(50).default(10),
    min_similarity: z.number().min(0).max(1).optional().describe('Optional minimum cosine similarity threshold')
  }
}, async ({ query, namespace, category, repo_path, project, limit, min_similarity }) => {
  if (!embeddingConfig.enabled) {
    return { content: [{ type: 'text', text: JSON.stringify({ enabled: false, error: 'Embeddings are not configured; use memory_search or memory_context_search.' }, null, 2) }] };
  }

  const queryEmbedding = await generateEmbedding(query);
  if (!queryEmbedding || !embeddingState.available) {
    return { content: [{ type: 'text', text: JSON.stringify({ enabled: true, available: false, warning: embeddingState.warning }, null, 2) }] };
  }

  const scopes = [];
  if (repo_path) scopes.push({ namespace: `repo:${repo_path}`, priority: 3 });
  if (project) scopes.push({ namespace: `project:${project}`, priority: 2 });
  if (scopes.length > 0) scopes.push({ namespace: 'global', priority: 1 });

  const params = [vectorLiteral(queryEmbedding)];
  const where = ['(expires_at is null or expires_at > now())', 'embedding is not null'];
  let selectPriority = '0 as scope_priority';
  let orderPrefix = '';
  let searchedNamespaces = null;

  if (scopes.length > 0) {
    searchedNamespaces = scopes.map(scope => scope.namespace);
    params.push(searchedNamespaces);
    const nsIdx = params.length;
    where.push(`namespace = any($${nsIdx}::text[])`);
    selectPriority = `case ${scopes.map((scope, index) => `when namespace = ($${nsIdx}::text[])[${index + 1}] then ${scope.priority}`).join(' ')} else 0 end as scope_priority`;
    orderPrefix = 'scope_priority desc, ';
  } else if (namespace) {
    params.push(namespace);
    where.push(`namespace = $${params.length}`);
  }

  if (category) {
    params.push(category);
    where.push(`category = $${params.length}`);
  }

  if (min_similarity !== undefined) {
    params.push(min_similarity);
    where.push(`(1 - (embedding <=> $1::vector)) >= $${params.length}`);
  }

  params.push(limit);
  const result = await pool.query(`
    select *,
      ${selectPriority},
      (1 - (embedding <=> $1::vector)) as similarity
    from agent_memories
    where ${where.join(' and ')}
    order by ${orderPrefix}embedding <=> $1::vector, importance desc, updated_at desc
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
        searched_namespaces: searchedNamespaces,
        priority: searchedNamespaces ? 'repo > project > global' : undefined,
        model: embeddingConfig.model,
        dimensions: embeddingConfig.dimensions,
        memories: result.rows.map(sanitizeRow)
      }, null, 2)
    }]
  };
});

server.registerTool('memory_backfill_embeddings', {
  description: 'Backfill missing memory embeddings. Defaults to dry_run=true and only reports candidate ids.',
  inputSchema: {
    dry_run: z.boolean().default(true),
    limit: z.number().int().min(1).max(500).default(50)
  }
}, async ({ dry_run, limit }) => {
  if (!embeddingConfig.enabled) {
    return { content: [{ type: 'text', text: JSON.stringify({ enabled: false, dry_run, candidates: 0, updated: 0, ids: [] }, null, 2) }] };
  }

  const updatedIds = [];

  if (!embeddingState.columnExists && embeddingConfig.dimensions) {
    await ensureEmbeddingSchema(embeddingConfig.dimensions);
  }

  if (!embeddingState.columnExists && !embeddingConfig.dimensions) {
    const first = await pool.query('select * from agent_memories order by updated_at desc limit 1');
    if (dry_run) {
      const candidates = await pool.query('select id from agent_memories order by updated_at desc limit $1', [limit]);
      return { content: [{ type: 'text', text: JSON.stringify({ enabled: true, available: false, warning: 'Embedding dimensions are not known yet; run with dry_run=false to generate the first embedding and initialize pgvector schema.', dry_run, candidates: candidates.rows.length, updated: 0, ids: candidates.rows.map(row => row.id) }, null, 2) }] };
    }
    if (first.rows[0] && await updateMemoryEmbedding(first.rows[0])) updatedIds.push(first.rows[0].id);
  }

  await refreshEmbeddingStatus();
  if (!embeddingState.columnExists) {
    return { content: [{ type: 'text', text: JSON.stringify({ enabled: true, available: false, warning: embeddingState.warning, dry_run, candidates: 0, updated: 0, ids: [] }, null, 2) }] };
  }

  const candidates = await pool.query(`
    select * from agent_memories
    where embedding is null
    order by updated_at desc
    limit $1
  `, [limit]);

  if (!dry_run) {
    for (const row of candidates.rows) {
      if (await updateMemoryEmbedding(row)) updatedIds.push(row.id);
    }
  }

  return { content: [{ type: 'text', text: JSON.stringify({ dry_run, candidates: candidates.rows.length, updated: updatedIds.length, ids: dry_run ? candidates.rows.map(row => row.id) : updatedIds }, null, 2) }] };
});

server.registerTool('memory_embedding_status', {
  description: 'Report optional embedding configuration, pgvector schema status, and embedding coverage counts.',
  inputSchema: {}
}, async () => {
  await refreshEmbeddingStatus();

  let counts = { total: 0, embedded: 0, missing: 0 };
  if (embeddingState.columnExists) {
    const result = await pool.query(`
      select
        count(*)::int as total,
        count(*) filter (where embedding is not null)::int as embedded,
        count(*) filter (where embedding is null)::int as missing
      from agent_memories
    `);
    counts = result.rows[0];
  } else {
    const result = await pool.query('select count(*)::int as total from agent_memories');
    counts.total = result.rows[0]?.total ?? 0;
    counts.missing = counts.total;
  }

  return { content: [{ type: 'text', text: JSON.stringify({
    enabled: embeddingConfig.enabled,
    available: embeddingState.available,
    model: embeddingConfig.model ?? null,
    dimensions: embeddingConfig.dimensions ?? embeddingState.columnDimensions,
    timeout_ms: embeddingConfig.timeoutMs,
    extension_available: embeddingState.extensionAvailable,
    column_exists: embeddingState.columnExists,
    column_dimensions: embeddingState.columnDimensions,
    warning: embeddingState.warning,
    counts: {
      total: Number(counts.total || 0),
      embedded: Number(counts.embedded || 0),
      missing: Number(counts.missing || 0)
    }
  }, null, 2) }] };
});

server.registerTool('memory_update', {
  description: 'Update an existing OpenCode memory by id.',
  inputSchema: {
    id: z.number().int().positive(),
    namespace: z.string().optional(),
    category: z.string().optional(),
    key: z.string().nullable().optional(),
    content: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    importance: z.number().int().min(0).max(10).optional(),
    confidence: z.number().min(0).max(1).optional(),
    last_confirmed_at: z.string().datetime().nullable().optional(),
    expires_at: z.string().datetime().nullable().optional()
  }
}, async ({ id, namespace, category, key, content, metadata, importance, confidence, last_confirmed_at, expires_at }) => {
  const result = await pool.query(`
    update agent_memories set
      namespace = coalesce($2, namespace),
      category = coalesce($3, category),
      key = case when $4::text = '__unchanged__' then key else $4::text end,
      content = coalesce($5, content),
      metadata = coalesce($6::jsonb, metadata),
      importance = coalesce($7, importance),
      confidence = coalesce($8, confidence),
      last_confirmed_at = case when $9::text = '__unchanged__' then last_confirmed_at else $9::timestamptz end,
      expires_at = case when $10::text = '__unchanged__' then expires_at else $10::timestamptz end,
      updated_at = now()
    where id = $1
    returning *
  `, [id, namespace ?? null, category ?? null, key === undefined ? '__unchanged__' : key, content ?? null, metadata === undefined ? null : JSON.stringify(metadata), importance ?? null, confidence ?? null, last_confirmed_at === undefined ? '__unchanged__' : last_confirmed_at, expires_at === undefined ? '__unchanged__' : expires_at]);

  if (result.rows[0] && (namespace !== undefined || category !== undefined || key !== undefined || content !== undefined || metadata !== undefined)) {
    await updateMemoryEmbedding(result.rows[0]);
  }

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
