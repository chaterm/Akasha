<div align="center">
  English / <a href="./README_zh.md">中文</a>
</div>
<br>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue?style=for-the-badge" alt="License"></a>
  <img src="https://img.shields.io/badge/Self--Hosted-First-0086FF?style=for-the-badge&logo=docker&logoColor=white" alt="Self-Hosted">
  <img src="https://img.shields.io/badge/Agent--Native-MCP-6E56CF?style=for-the-badge" alt="Agent Native">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/AI-Native-blue?style=flat" alt="AI Native">
  <img src="https://img.shields.io/badge/PostgreSQL-pgvector-336791?style=flat&logo=postgresql&logoColor=white" alt="pgvector">
  <img src="https://img.shields.io/badge/Node.js-22+-5FA04E?style=flat&logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/pnpm-workspace-F69220?style=flat&logo=pnpm&logoColor=white" alt="pnpm">
</p>

## Table of Contents

- [Introduction](#introduction)
  - [Why Choose Akasha](#why-choose-akasha)
  - [Key Features](#key-features)
  - [Core Concepts](#core-concepts)
    - [Three-Layer Memory](#three-layer-memory)
    - [Context Graph](#context-graph)
    - [Living Knowledge](#living-knowledge)
    - [Cognitive Compounding](#cognitive-compounding)
  - [Design Philosophy](#design-philosophy)
  - [Technology Stack](#technology-stack)
  - [Development Guide](#development-guide)
    - [Prerequisites](#prerequisites)
    - [Install](#install)
    - [Start Dependencies](#start-dependencies)
    - [Development](#development)
    - [Build](#build)
    - [Troubleshooting](#troubleshooting)
  - [Agent Skill](#agent-skill)
  - [Self-hosted First](#self-hosted-first)
  - [Acknowledgements](#acknowledgements)
  - [Contributors](#contributors)

# Introduction

Akasha is an enterprise memory system built for humans and agents alike. It turns the experience scattered across individuals, teams, and business lines into organizational knowledge that accumulates, gets reused, and keeps evolving.

It solves three problems:

1. **Turn fragmented information into knowledge.** Documents, meetings, conversations, and email are captured into one place, so knowledge stops leaking away.

2. **Keep knowledge accurate over time.** The Dream Cycle organizes, verifies, and updates knowledge automatically, building up a knowledge graph as it goes.

3. **Give agents domain experience.** Skills and progressive disclosure hand agents the domain knowledge and operating experience they need.

> "Without memory, intelligence is just algorithm. With memory, intelligence becomes a species."

![Preview image](resources/hero1.webp)

![Preview image](resources/hero2.webp)

## Why Choose Akasha

Akasha is not a better wiki, it's a memory system. A knowledge base waits; memory participates.

- 🧠 **Memory, not storage** — actively remembers, associates, and surfaces context instead of filing documents

- 🌱 **Emergent knowledge** — grows from how people actually work, not from top-down mandates to keep the wiki updated

- 🔄 **Self-maintaining** — the Dream Cycle verifies and refreshes knowledge so answers don't rot

- 🤖 **Built for agents too** — humans and agents are both first-class citizens, with the same permissions model

- 🔍 **Provenance by default** — every memory carries its origin, freshness, and confidence

- 🏠 **Self-hosted** — your data, your memory, your reasoning

## Key Features

- 🗂️ **Unified Capture**

  Documents, meetings, conversations, and email land in one system instead of a dozen tools, so knowledge stops leaking on the way.

  Entity and relation extraction run on ingest, and permissions travel with the content.

- 🌙 **Dream Cycle**

  Knowledge is organized, verified, and updated automatically in the background, and the knowledge graph is built up incrementally as it runs.

  Staleness detection, confidence scoring, and contradiction discovery keep answers from quietly going out of date.

- ⚡ **Skills for Agents**

  Domain knowledge and operating experience are packaged as Skills that agents can load and reuse.

  Progressive disclosure keeps the context window lean: agents pull detail only when the task needs it.

- 🕸️ **Context Graph**

  People, decisions, events, services, and commitments are connected into a living map of what the organization means, not just what it stored.

  Graph traversal answers questions a search box cannot, like why a decision was made and who disagreed.

- 📝 **Workspace & Collaboration**

  Real-time collaborative editing, spaces and projects, Markdown, rich text, version history, comments, and RBAC.

- 🔌 **MCP-Compatible APIs**

  Memory, graph, and retrieval APIs are exposed over MCP with full audit trails, so agents read and write memory inside permission boundaries.

## Core Concepts

### Three-Layer Memory

| Layer | Question it answers | What it holds |
|-------|--------------------|---------------|
| Factual Memory | What happened | Artifacts with provenance, permissions, freshness, and relationships |
| Interaction Memory | Why it mattered | Decisions, disagreements, tradeoffs, commitments, untested assumptions |
| Action Memory | What to do next | Workflows, guardrails, and the results of past execution |

Factual memory is more than RAG — it's a semantic file system with durable structure. Interaction memory captures the organizational reasoning that rarely makes it into any artifact: a transcript is not enough, and neither is a summary. Action memory participates in operations, and **doing nothing is a first-class action** — a system that cannot stay still on purpose cannot be trusted to act on purpose.

### Context Graph

The reasoning layer, where facts become a model of the company:

```text
Customer Call → Opportunity → Product Gap → Engineering Tradeoff → Roadmap Decision → Strategy
Service → Team → Codebase → Deployment → Incident → SOP → Owner → Skill
```

This is also where metacognition lives: knowing when evidence is weak, when context is stale, when teams hold conflicting assumptions, when a commitment has no owner, and when an agent needs help.

### Living Knowledge

Knowledge is born, verified, used, strengthened, challenged, outdated, and retired. The Dream Cycle manages that lifecycle — freshness and staleness detection, confidence scoring, contradiction discovery, semantic version diff, deprecation warnings, and re-activation when dormant knowledge becomes relevant again.

### Cognitive Compounding

One agent's insight propagates to all of them at zero marginal learning cost. Every execution generates training signal, patterns emerge from accumulated action memory, and Skills improve through feedback loops. The organization gets smarter without anyone "doing knowledge management."

## Design Philosophy

1. **Memory, not storage.** A knowledge base waits. Memory participates.
2. **Emergence, not imposition.** If maintaining the system is separate from doing the work, the system dies.
3. **Participation, not retrieval.** Zero-search is the goal: memory shows up when context changes.
4. **Judgment, not just action.** Knowing when *not* to act matters as much as acting.
5. **Provenance, not just content.** In an enterprise, a plausible answer without provenance is dangerous.
6. **Compounding, not accumulation.** Every execution is training; every interaction is a Bayesian update.
7. **Human as meaning.** AI handles the infinite "how"; people define "why."

## Technology Stack

| Layer | Choice |
|-------|--------|
| Frontend | React, ProseMirror / TipTap |
| Backend | NestJS, pnpm workspace monorepo (Nx) |
| Storage | PostgreSQL 18 + pgvector, Redis |
| Knowledge | Entity extraction, semantic relation engine, vector search with freshness and confidence weighting |
| Agent | MCP memory APIs, Skills with progressive disclosure, guardrail-aware execution |

## Development Guide

### Prerequisites

- [Node.js](https://nodejs.org/) 22+ (LTS recommended)
- [pnpm](https://pnpm.io/) 10.4.0 (see `packageManager` in `package.json`)
- PostgreSQL 18 with the [pgvector](https://github.com/pgvector/pgvector) extension available
- Redis (local install or container)

Migrations run `CREATE EXTENSION IF NOT EXISTS vector` themselves, so you don't create the extension by hand. What you must provide is a PostgreSQL server that *has pgvector installed*, otherwise that migration fails.

### Install

```bash
git clone https://github.com/jarvishappy/Akasha.git
cd Akasha
pnpm install
```

> Use `pnpm`, not `npm`. This is a pnpm workspace monorepo.

Copy the environment file and set a local secret:

```bash
cp .env.example .env
openssl rand -hex 32   # use the output as APP_SECRET
```

The other defaults are ready for the included PostgreSQL Docker Compose service and a local Redis on `6379`.

### Start Dependencies

**PostgreSQL — Option A, Docker (recommended).** The `pgvector/pgvector` image ships the extension, and Compose already provisions the `akasha` role and database:

```bash
docker compose up -d db
```

**PostgreSQL — Option B, native install (macOS/Homebrew).** `postgresql@18` is keg-only, so the binaries are not on `PATH`; the snippets below call them through `$PGB`:

```bash
brew install postgresql@18 pgvector
export PGB=/opt/homebrew/opt/postgresql@18/bin

# Initialize the cluster (once) and start the server
$PGB/initdb --locale=C -E UTF-8 -D /opt/homebrew/var/postgresql@18
mkdir -p /opt/homebrew/var/log
$PGB/pg_ctl -D /opt/homebrew/var/postgresql@18 \
  -l /opt/homebrew/var/log/postgresql@18.log start

# Create the role and database that DATABASE_URL expects
$PGB/psql -d postgres -c \
  "CREATE ROLE akasha LOGIN PASSWORD 'STRONG_DB_PASSWORD' SUPERUSER;"
$PGB/createdb -O akasha akasha

# Verify pgvector is visible to the server
$PGB/psql -d akasha -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "SELECT extname, extversion FROM pg_extension;"
```

**Redis:**

```bash
brew services start redis              # managed background service
redis-server --port 6379 --daemonize yes   # or a plain process
docker run -d --name akasha-redis -p 6379:6379 redis:7   # or a container

redis-cli ping   # -> PONG
```

### Development

Run migrations, then start both dev servers:

```bash
pnpm --filter ./apps/server run migration:latest
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000). The frontend dev server runs on port 3000 and proxies `/api`, `/socket.io`, and `/collab` to `BACKEND_URL`.

To verify the backend and its dependencies:

```bash
curl http://127.0.0.1:8080/api/health
```

A healthy stack reports both dependencies as `up`:

```json
{
  "status": "ok",
  "info": { "database": { "status": "up" }, "redis": { "status": "up" } },
  "error": {},
  "details": { "database": { "status": "up" }, "redis": { "status": "up" } }
}
```

Docker Compose and `brew services` restart on their own after a reboot. A natively installed PostgreSQL started through `pg_ctl`, or a Redis started with `--daemonize`, does not — bring them back up before `pnpm run dev`.

### Build

```bash
pnpm run build           # all packages
pnpm run client:build    # frontend only
pnpm run server:build    # backend only
```

### Troubleshooting

**`initdb: error: file ".../postgres.bki" does not exist` after installing `postgresql@18` via Homebrew.** Homebrew installs the keg but performs the prefix symlinks in a separate post-install step. On older Homebrew versions that step can abort (`unknown install step: link_dir`, or `undefined method 'stop_timeout'`), leaving the keg's `share/postgresql` unlinked as `share/postgresql@18` — which is where `pg_config` points. Upgrade Homebrew itself, then reinstall so the step runs:

```bash
brew update
brew reinstall postgresql@18
```

**AI features appear inert.** AI and knowledge-compilation features are gated on `AI_DRIVER`. When it is unset, the validation in `apps/server/src/integrations/environment/environment.validation.ts` skips every AI-related variable and those subsystems stay idle; the wiki, editor, and real-time collaboration are unaffected. To enable them, set `AI_DRIVER` plus the matching credentials for that provider.

**`DATABASE_URL` points at a database that does not exist.** The name in your `.env` must match the database you created. Older local `.env` files inherited from the upstream project may still reference `docmost` rather than `akasha`; either update the connection string and re-run the migrations, or create the database under the name already configured.

## Agent Skill

The Akasha Agent Skill lets coding agents query wiki knowledge with citations, read shared pages they have permission to see, and create, read, update, delete, and restore pages in a personal space.

```bash
npx skills add chaterm/Akasha --skill akasha --agent codex --global --yes
```

Start a new agent session afterwards so the Skill is discovered. Drop `--agent codex` to pick a different target agent interactively. On first use, run the authentication command the agent gives you in your own terminal and enter the API key at the hidden prompt — never paste the key into command arguments, source files, logs, or chat messages.

See [`skills/README.md`](./skills/README.md) for details and [`skills/akasha/SKILL.md`](./skills/akasha/SKILL.md) for the full behavior and permission constraints.

## Self-hosted First

Akasha is designed for enterprise self-hosting, private cloud, on-prem deployment, air-gapped environments, and internal AI systems. Organizations own their data, memory, reasoning, workflows, and organizational intelligence.

Memory is not something you rent. You cannot rent a nervous system.

## Acknowledgements

Akasha builds upon excellent open-source projects. We gratefully acknowledge:

- **[Docmost](https://github.com/docmost/docmost)** — the collaborative wiki foundation that the workspace and editor layers build on.

## Contributors

Thank you for your contribution!
Please refer to the <a href="./CONTRIBUTING.md">Contribution Guide</a> for more information.
