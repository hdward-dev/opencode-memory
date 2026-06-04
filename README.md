# OpenCode Memory

PostgreSQL-backed long-term memory for OpenCode, packaged as a Model Context Protocol (MCP) server with a local dashboard.

## Features

- MCP tools for adding, searching, updating, deleting, confirming, and cleaning memories.
- Contextual search priority: `repo:<absolute-path>` > `project:<name>` > `global`.
- PostgreSQL persistence with indexes and full-text search support.
- Local dashboard for memory contents, usage, expiry, and cleanup candidates.
- Category-based TTL and forgetting behavior.

## License

MIT

## Requirements

- Bun or Node.js 20+
- PostgreSQL
- `OC_MEMORY_DATABASE_URL` environment variable

No database URL, password, API key, or secret is embedded in this project. Both the MCP server and dashboard require `OC_MEMORY_DATABASE_URL`.

## Installation

```sh
bun install
```

Node/npm also works:

```sh
npm install
```

## PostgreSQL setup

Create a database and user using your preferred PostgreSQL administration method. Example only:

```sql
create database oc_memory;
create user oc_memory_user with password 'REPLACE_WITH_A_STRONG_PASSWORD';
grant all privileges on database oc_memory to oc_memory_user;
```

Then set:

```sh
export OC_MEMORY_DATABASE_URL='postgresql://oc_memory_user:REPLACE_WITH_A_STRONG_PASSWORD@localhost:5432/oc_memory'
```

The MCP server initializes the `agent_memories` schema automatically on startup.

## Scripts

```sh
bun run mcp        # start MCP server over stdio
bun run dashboard  # start dashboard
bun run start      # alias for dashboard
bun run check      # syntax-check source files
```

Equivalent npm commands work as well, for example `npm run mcp`.

## OpenCode MCP config

See [`examples/opencode.config.example.json`](examples/opencode.config.example.json).

Example shape:

```json
{
  "mcp": {
    "oc-memory": {
      "type": "local",
      "command": ["bun", "run", "mcp"],
      "environment": {
        "OC_MEMORY_DATABASE_URL": "postgresql://USER:PASSWORD@HOST:5432/oc_memory"
      },
      "enabled": true
    }
  }
}
```

Use a real connection string only in your private OpenCode configuration or environment, never in committed files.

## Dashboard

Start locally:

```sh
OC_MEMORY_DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/oc_memory' bun run dashboard
```

Defaults:

- Host: `127.0.0.1`
- Port: `18765`
- URL: `http://127.0.0.1:18765`

Optional environment variables:

- `OC_MEMORY_DASHBOARD_HOST`
- `OC_MEMORY_DASHBOARD_PORT`

The dashboard exposes:

- `/` web UI
- `/api/health`
- `/api/stats`
- `/api/memories`
- `/api/expiring`
- `/api/cleanup-candidates`

A launchd example is available at [`examples/launchd/cc.geekland.oc-memory-dashboard.plist`](examples/launchd/cc.geekland.oc-memory-dashboard.plist). Replace all placeholder paths and database values before use.

## MCP tools

- `memory_add`: add or upsert a durable memory. If `key` is provided, `namespace + category + key` is upserted.
- `memory_search`: search active memories by text, namespace, and category.
- `memory_context_search`: search contextual scopes with priority `repo > project > global`.
- `memory_update`: update a memory by id.
- `memory_delete`: delete a memory by id.
- `memory_list_categories`: list namespaces/categories with counts.
- `memory_cleanup`: delete expired and stale low-value memories; defaults to dry run.
- `memory_review_candidates`: find memories that should be reconfirmed.
- `memory_confirm`: mark a memory as reconfirmed.

## TTL and forgetting behavior

When `memory_add` omits `expires_at`, category defaults are applied:

- `profile`, `preference`, `decision`: permanent unless contradicted
- `project`, `lesson`: 180 days
- `note`: 30 days
- `tool`: 7 days

Use `expires_at: null` only for genuinely durable memories. Temporary context should use `note` or `tool`, not `profile` or `preference`.

Forgetting policy:

- Expired memories are excluded from normal search results.
- `memory_cleanup` can remove expired memories and low-importance stale `note`/`tool` memories.
- Run `memory_cleanup` with `dry_run: true` first unless you intentionally want deletion.
- Use `memory_review_candidates` and `memory_confirm` to periodically reconfirm old/high-impact permanent memories.

## Memory usage guidance

See [`docs/memory.md`](docs/memory.md) for suggested OpenCode instructions and tool usage policy.
