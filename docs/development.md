# Development Setup

This document contains the detailed local-development setup for Akasha. The root README keeps only the short product-oriented quick start.

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or later
- [pnpm](https://pnpm.io/) 10.4.0, as specified by the repository
- PostgreSQL 18 with the UTF8 encoding, and these extensions available on the
  server:
  - [pgvector](https://github.com/pgvector/pgvector) (`vector`)
  - `pg_trgm` and `unaccent`
  - [pg_jieba](https://github.com/jaiminpan/pg_jieba), which must also be listed
    in `shared_preload_libraries`
- Redis
- Docker and Docker Compose, if you want to use the provided PostgreSQL container

The server refuses to start on a database that does not meet these requirements; the
checks live in `apps/server/src/database/services/database-requirements.service.ts`.
Chinese full-text search depends on the `jiebacfg` and `jiebaqry` text search
configurations that pg_jieba provides, so a plain `pgvector/pgvector` image is not
enough.

The included Compose configuration builds a PostgreSQL 18 image with pgvector,
pg_trgm, and pg_jieba preloaded. Redis must be provided separately, either as a local
service or as its own container.

## Configuration

Create a local environment file:

```bash
cp .env.example .env
```

Generate a local application secret and set it as `APP_SECRET` in `.env`:

```bash
openssl rand -hex 32
```

If you use native PostgreSQL or Redis, update `DATABASE_URL` and `REDIS_URL` so
they match your local services. Do not commit `.env` or production credentials.

AI capabilities are optional. Configure the compiler, answer, image, and embedding
models independently from **Settings → AI → Models** after the application starts.
The API key is stored encrypted and is not shown again after saving.

## Start Dependencies

### PostgreSQL with Docker

The repository includes a Compose service that builds
[`docker/postgres`](../docker/postgres/Dockerfile): PostgreSQL 18, pgvector, pg_trgm,
and pg_jieba with `shared_preload_libraries=pg_jieba`. The build fetches pg_jieba and
cppjieba at pinned commits, so the first start needs network access:

```bash
docker compose up -d db
```

It creates the `akasha` database and user expected by the default `DATABASE_URL`.
The migration scripts create the required database extensions automatically, but the
PostgreSQL installation must already ship them.

### Redis

The Compose file does not include Redis. Start Redis separately, for example:

```bash
docker run -d --name akasha-redis -p 6379:6379 redis:7
```

Or use a local Redis service. Verify it is available with:

```bash
redis-cli ping
# PONG
```

## Run the Application

After PostgreSQL and Redis are running, apply the database migrations:

```bash
pnpm --filter ./apps/server run migration:latest
```

Start the frontend and backend development servers:

```bash
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000). By default, the backend listens on
port `8080`, and the frontend proxies `/api`, `/mcp`, and `/socket.io` to
`BACKEND_URL`.

Check the backend and dependency health:

```bash
curl http://127.0.0.1:8080/api/health
```

### Collaboration server

Collaboration WebSockets are served by the API process itself.
`CollaborationModule` attaches an upgrade handler at `/collab` to the API HTTP server
(`apps/server/src/collaboration/collaboration.module.ts`), so the Vite proxy's
`/collab` route reaches it and real-time editing works with `pnpm run dev` alone.

A standalone collaboration process is also provided, for deployments that want to scale
or restart collaboration independently of the API:

```bash
pnpm run server:build     # collab:dev runs the compiled output from apps/server/dist
pnpm run collab:dev       # serves /collab on port 3001 (COLLAB_PORT)
```

The browser can reach it either through a reverse proxy that routes `/collab` to that
port, or directly by setting `COLLAB_URL=http://localhost:3001`. Leave `COLLAB_URL`
unset to keep using the API's built-in endpoint. Collaboration instances synchronize
through Redis; `COLLAB_DISABLE_REDIS=true` is only for a single process.

## Build

```bash
pnpm run build           # Build all workspace projects
pnpm run client:build    # Build the frontend
pnpm run server:build    # Build the backend
```

Build artifacts are generated under the corresponding `apps/*/dist` and `packages/*/dist`
directories.

The repository also ships a `Makefile` with shortcuts for the common steps:
`make db`, `make install`, `make migrate`, and `make dev`.

## API reference

- [`iself-agent-api-key.yaml`](./iself-agent-api-key.yaml): agent API-key provisioning
  and space binding endpoints used by the iself platform.
- [`iself-llm-wiki-query.yaml`](./iself-llm-wiki-query.yaml): knowledge retrieval
  endpoint consumed by iself agents, including request fields and response shapes.

## Troubleshooting

### AI features are unavailable

Configure the required models from **Settings → AI → Models**. The compiler, answer,
image, and embedding capabilities are configured independently. Check the provider,
model name, base URL, and API key.

### Migration fails while creating extensions

PostgreSQL must provide `vector`, `pg_trgm`, and `pg_jieba`. A stock
`pgvector/pgvector` image lacks pg_jieba; use the Compose service in this repository or
install pg_jieba on the server.

### The server reports a database requirement error

The requirement check rejects PostgreSQL older than 18, non-UTF8 databases, missing
extensions, and a missing `pg_jieba` entry in `shared_preload_libraries`. Fix the
database rather than bypassing the check, then restart the server.

### The database cannot be found

Make sure the database name, username, password, and host in `DATABASE_URL` match the
PostgreSQL service created for Akasha.

### Redis connection errors

Make sure Redis is running and that `REDIS_URL` points to the correct host and port.
Verify the service with:

```bash
redis-cli ping
```

### Page editing does not sync between browsers

The client connects to `<base>/collab` over WebSocket. Confirm that path reaches a
collaboration endpoint: either the API's built-in handler (the default), or the standalone
process when you set `COLLAB_URL`. If `COLLAB_URL` points at another host or port, make
sure that process is running and reachable from the browser, and that Redis is up.
