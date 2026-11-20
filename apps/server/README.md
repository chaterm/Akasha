# Akasha Server

NestJS (Fastify) backend for Akasha: the REST API, the MCP endpoint used by agents,
knowledge compilation and retrieval, and the collaboration WebSocket server.

Local setup, environment variables, and troubleshooting live in
[`docs/development.md`](../../docs/development.md). This file only covers what is in
this package and how to run it.

## Run

From the repository root:

```bash
pnpm --filter ./apps/server run migration:latest   # apply pending migrations
pnpm run server:dev                                # watch mode, listens on $PORT (default 8080)
```

The API process also serves the collaboration WebSocket at `/collab`. The `collab:dev`
and `collab:prod` scripts run that same gateway as a standalone process instead
(`dist/collaboration/server/collab-main`, default port 3001), for deployments that scale
or restart collaboration separately. Both scripts run the compiled output, so build with
`pnpm run server:build` first.

Health and dependency status: `GET /api/health`.

## Database

- Migrations live in `src/database/migrations` and are applied with
  `migration:latest`; `migration:create` scaffolds a new one, `migration:down` and
  `migration:reset` roll back, `migration:prune-history` trims the history table.
- The server requires PostgreSQL 18 with UTF8, the `vector`, `pg_trgm`, and
  `pg_jieba` extensions, and `pg_jieba` in `shared_preload_libraries`
  (`src/database/services/database-requirements.service.ts`). The Compose service in
  the repository root ships exactly that image.
- `migration:codegen` regenerates `src/database/types/db.d.ts` from a live database.

## Scripts

| Script | Purpose |
| --- | --- |
| `start:dev` | Watch-mode development server |
| `build` / `start:prod` | Compile to `dist` / run the compiled API |
| `collab:dev` / `collab:prod` | Run the collaboration server from `dist` |
| `lint` / `format` | ESLint with autofix / Prettier |
| `test` / `test:cov` / `test:e2e` | Jest unit tests, coverage, e2e suite |
| `skill:node-reference` | Regenerate the addressable-node reference shipped with the agent skills |
| `backfill:zh-search` | Backfill Chinese full-text search columns |

## Layout

| Path | Contents |
| --- | --- |
| `src/core` | Pages, spaces, comments, attachments, MCP tools, weekly report |
| `src/features` | AI chat, knowledge (llm-wiki) compilation and retrieval, imports, API keys |
| `src/collaboration` | Hocuspocus-style collaboration server, page edit operations |
| `src/database` | Kysely setup, migrations, requirement checks |
| `src/integrations` | Environment, health, storage, mail, SSO |

Log calls pass a leading object and a constant message; ESLint enforces this
(`eslint.config.mjs`). See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) for the
repository-wide conventions.
