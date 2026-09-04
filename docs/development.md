# Development Setup

This document contains the detailed local-development setup for Akasha. The root README keeps only the short product-oriented quick start.

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or later
- [pnpm](https://pnpm.io/) 10.4.0, as specified by the repository
- PostgreSQL with the [pgvector](https://github.com/pgvector/pgvector) extension; the knowledge-retrieval migrations require pgvector 0.8.0 or later
- Redis
- Docker and Docker Compose, if you want to use the provided PostgreSQL container

The included Compose configuration provides PostgreSQL with pgvector. Redis must be provided separately, either as a local service or as its own container.

## Configuration

Create a local environment file:

```bash
cp .env.example .env
```

Generate a local application secret and set it as `APP_SECRET` in `.env`:

```bash
openssl rand -hex 32
```

If you use native PostgreSQL or Redis, update `DATABASE_URL` and `REDIS_URL` so they match your local services. Do not commit `.env` or production credentials.

AI capabilities are optional. Configure the compiler, answer, image, and embedding models independently from **Settings → AI → Models** after the application starts. The API key is stored encrypted and is not shown again after saving.

## Start Dependencies

### PostgreSQL with Docker

The repository includes a Compose service based on `pgvector/pgvector`. It creates the `akasha` database and user expected by the default `DATABASE_URL`:

```bash
docker compose up -d db
```

The migration scripts create the required database extensions automatically, but the PostgreSQL installation must already include pgvector.

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

Open [http://localhost:3000](http://localhost:3000). By default, the backend listens on port `8080`, and the frontend proxies `/api`, `/mcp`, `/socket.io`, and `/collab` to `BACKEND_URL`.

Check the backend and dependency health:

```bash
curl http://127.0.0.1:8080/api/health
```

## Build

```bash
pnpm run build           # Build all workspace projects
pnpm run client:build    # Build the frontend
pnpm run server:build    # Build the backend
```

Build artifacts are generated under the corresponding `apps/*/dist` and `packages/*/dist` directories.

## Troubleshooting

### AI features are unavailable

Configure the required models from **Settings → AI → Models**. The compiler, answer, image, and embedding capabilities are configured independently. Check the provider, model name, base URL, and API key.

### Migration fails while enabling pgvector

Make sure the PostgreSQL server has pgvector installed and that the installed version is 0.8.0 or later.

### The database cannot be found

Make sure the database name, username, password, and host in `DATABASE_URL` match the PostgreSQL service created for Akasha.

### Redis connection errors

Make sure Redis is running and that `REDIS_URL` points to the correct host and port. Verify the service with:

```bash
redis-cli ping
```
