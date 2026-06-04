# OpenCode Long-Term Memory

OpenCode has a PostgreSQL-backed memory MCP server named `oc-memory`.

Use memory deliberately:

- Search memory near the start of a task when durable user preferences, project conventions, prior decisions, or recurring context may matter.
- For coding/project tasks, prefer `memory_context_search` with the current repo path and/or project name so repo/project memories override global memories.
- If optional embeddings are enabled, use `memory_semantic_search` when the idea matters more than exact wording; otherwise use the text/context search tools.
- Write memory only for stable, reusable facts: user preferences, persistent profile facts, project conventions, important decisions, and lessons likely to help future sessions.
- Do not store secrets, API keys, passwords, one-off task details, transient emotions, or sensitive personal data unless the user explicitly asks.
- Prefer updating an existing memory over creating duplicates. Use stable `key` values for preferences and recurring project facts.
- Treat memory as corrigible, not truth. If the user contradicts, denies, or says a stored memory/rule is no longer true, immediately find the matching memory and either delete it (`memory_delete`) or update it (`memory_update`). Do not keep contradicted memory around.
- Use namespaces:
  - `global` for cross-project user preferences.
  - `project:<name>` for durable project knowledge.
  - `repo:<absolute-path>` for repository-specific conventions.
- Scope priority is: `repo:<absolute-path>` > `project:<name>` > `global`.
- Use categories: `profile`, `preference`, `project`, `decision`, `lesson`, `note`, `tool`.
- Keep memory content concise and factual.

Forgetting and confirmation policy:

- Default TTLs are applied by `memory_add` when `expires_at` is omitted:
  - `profile`, `preference`, `decision`: permanent unless contradicted.
  - `project`, `lesson`: 180 days.
  - `note`: 30 days.
  - `tool`: 7 days.
- Use `expires_at: null` only for genuinely durable memory.
- For temporary context, always use `note` or `tool`, not `profile`/`preference`.
- Occasionally ask concise confirmation questions for old/high-impact memories using `memory_review_candidates`, especially before relying on a preference/profile/project fact that has not been confirmed recently.
- If the user confirms a memory, call `memory_confirm`.
- If the user denies a memory, call `memory_delete`; if they correct it, call `memory_update` with the corrected content.
- Periodically run `memory_cleanup` to remove expired and stale low-value memories. Use `dry_run: true` first unless the user explicitly requested cleanup.

Available tools:

- `memory_search`: find memories by query / namespace / category.
- `memory_context_search`: search contextual scopes with priority `repo > project > global`.
- `memory_semantic_search`: optional pgvector semantic search; accepts `query`, optional `namespace`/`category`, optional `repo_path`/`project`, `limit`, and `min_similarity`.
- `memory_add`: add or upsert durable memory.
- `memory_update`: update by id.
- `memory_delete`: delete by id.
- `memory_list_categories`: inspect memory namespaces and categories.
- `memory_cleanup`: delete expired/stale low-value memories; use dry-run first.
- `memory_backfill_embeddings`: optional tool to preview/fill missing embeddings; defaults to `dry_run: true`.
- `memory_embedding_status`: inspect embedding config, pgvector/column status, and coverage counts.
- `memory_review_candidates`: find memories that should be reconfirmed with the user.
- `memory_confirm`: mark a memory as confirmed by the user.

Optional semantic search setup:

- Semantic search is disabled unless these are configured: `OC_MEMORY_EMBEDDING_API_KEY` and `OC_MEMORY_EMBEDDING_MODEL`; `OC_MEMORY_EMBEDDING_URL` defaults to the OpenAI-compatible embeddings endpoint only when both are set.
- Optional variables: `OC_MEMORY_EMBEDDING_DIMENSIONS` and `OC_MEMORY_EMBEDDING_TIMEOUT_MS` (default `15000`).
- When enabled, the server attempts to install/use pgvector and add `agent_memories.embedding vector(<dimensions>)`. If pgvector or migration is unavailable, it logs a warning and continues with normal text search.
- Use placeholders only in committed examples; never store real database URLs or embedding API keys in docs/config.

Dashboard:

- Local dashboard script: `src/memory-dashboard.mjs`.
- Start with: `bun run dashboard` or `npm run dashboard` from this project.
- Default URL: `http://127.0.0.1:18765`.
- Shows memory contents, usage rate/access counts, vector coverage when available, expiring memories, and cleanup candidates.
