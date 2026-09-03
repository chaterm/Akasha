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
    - [Knowledge Compilation](#knowledge-compilation)
    - [Source-Grounded Knowledge](#source-grounded-knowledge)
    - [Relationship-Aware Knowledge](#relationship-aware-knowledge)
    - [Human and Agent Access](#human-and-agent-access)
  - [Roadmap / Vision](#roadmap--vision)
    - [Organizational Memory Beyond Pages](#organizational-memory-beyond-pages)
    - [Compounding Agent Experience](#compounding-agent-experience)
  - [Development](#development)
    - [Install](#install)
    - [Start](#start)
    - [Build](#build)
  - [Agent Integration](#agent-integration)
  - [Self-hosted](#self-hosted)
  - [Acknowledgements](#acknowledgements)
  - [Contributors](#contributors)

# Introduction

Akasha is an enterprise knowledge and memory workspace for humans and agents.

It helps organizations turn scattered work context and experience into knowledge that can be discovered, connected, reused, and grounded in its sources. Teams collaborate in shared spaces, while agents retrieve and work with organizational knowledge within the same permission boundaries.

Akasha brings together a collaborative Wiki, AI-powered knowledge compilation and retrieval, relationship-aware navigation, and MCP-based agent access in a self-hosted platform.

![Preview image](resources/hero1.webp)

![Preview image](resources/hero2.webp)

## Why Choose Akasha

Akasha combines the familiarity of a collaborative Wiki with an AI-ready knowledge layer.

- 🧠 **Knowledge that stays connected** — Pages, spaces, attachments, and compiled knowledge are connected through links, citations, and relationships.

- 🔍 **Answers grounded in sources** — AI retrieval and answers can point back to source pages and supporting evidence instead of returning unsupported summaries.

- 🤝 **Built for humans and agents** — People and agents access the same knowledge surface within the same workspace and permission model.

- 🕸️ **Context beyond keyword search** — Relationship-aware navigation helps users explore how pages, concepts, entities, and sources are connected.

- 🏠 **Self-hosted by design** — Organizations can run Akasha in their own environment and control their data, storage, and model endpoints.

## Key Features

- 📝 **Collaborative Knowledge Workspace**

  Create and organize pages in shared spaces with rich-text editing, Markdown support, attachments, comments, version history, real-time collaboration, and access control.

- 🌙 **AI Knowledge Compilation**

  Queue selected pages and spaces for asynchronous compilation into structured knowledge artifacts. Jobs begin processing after they are enqueued; the pipeline can identify entities, concepts, claims, relations, comparisons, contradictions, and supporting evidence.

- 🔍 **Source-Grounded Retrieval and Q&A**

  Search and ask questions over organizational knowledge using lexical and vector retrieval. When workspace knowledge is used, answers include source-page citations and supporting evidence, with permission-aware results.

- 🕸️ **Relationship Graph**

  Explore direct page links and semantic relationships through a visual graph. Graph data is filtered according to the user's access permissions.

- 🤖 **Agent Access through MCP**

  Connect agents to Akasha through the `/mcp` endpoint. Agents can query knowledge and perform permitted operations on pages, spaces, comments, attachments, and workspace information using API-key authentication.

## Core Concepts

### Knowledge Compilation

Akasha keeps original Wiki pages and imported content as the source layer, then builds a structured knowledge layer from them.

The compilation pipeline analyzes source content and produces knowledge artifacts such as summaries, entities, concepts, claims, relations, comparisons, and contradictions. Each artifact retains its source references and evidence so that compiled knowledge can be traced back to the original content.

```text
Wiki pages / imported content
            ↓
    Knowledge compilation
            ↓
Structured artifacts + evidence + indexes
            ↓
   Retrieval / Q&A / graph navigation
```

Compilation augments the original Wiki; it does not replace it. Source pages remain available for reading, editing, permission checks, and citation.

### Source-Grounded Knowledge

Akasha distinguishes between source content and derived knowledge.

Original Wiki pages and imported content remain the primary sources. Compiled artifacts and AI answers are derived from those sources and retain citations, source references, or supporting evidence whenever available.

This makes it possible to:

- trace a compiled claim back to its source page;
- inspect the evidence behind an answer;
- respect source-page permissions during retrieval;
- identify knowledge that needs to be refreshed after its sources change.

When the available evidence is insufficient, the system can indicate that limitation instead of presenting an unsupported conclusion as fact.

### Relationship-Aware Knowledge

Akasha does not treat knowledge as a collection of isolated pages.

The knowledge layer records direct page links and semantic relationships discovered during compilation. These relationships connect pages, sections, entities, concepts, and shared sources, making it easier to explore related context and navigate across a knowledge space.

The relationship graph is an aid for discovery and retrieval, not a replacement for the original source pages. Graph results are filtered according to the user's access permissions.

### Human and Agent Access

Akasha is designed for both people and agents.

People use the Wiki interface to create, edit, organize, and discuss knowledge. Agents connect through MCP to search knowledge and perform permitted operations on pages, spaces, comments, attachments, and workspace information.

Both access paths use workspace and resource-level authorization. Agent requests are authenticated with API keys, and supported knowledge queries and operations are recorded for auditing.

## Roadmap / Vision

The following ideas describe Akasha's product direction. They are exploratory plans and should not be read as a list of features guaranteed to be available in the current release.

### Organizational Memory Beyond Pages

Akasha aims to evolve from a knowledge workspace into a broader organizational memory system:

- **Factual memory** — what happened, supported by source artifacts and provenance;
- **Interaction memory** — why decisions, disagreements, and trade-offs mattered;
- **Action memory** — what actions, workflows, and safeguards should follow.

### Compounding Agent Experience

Akasha may eventually allow reusable agent skills, operating patterns, and execution feedback to accumulate across tasks and agents, so that organizational experience becomes easier to reuse over time.

## Development

### Install

```bash
git clone https://github.com/fishyu-mushroom/Akasha.git
cd Akasha
pnpm install
```

This repository is a pnpm workspace monorepo. Use `pnpm` for dependency installation and scripts.

Create the local environment file:

```bash
cp .env.example .env
```

Generate a local application secret and set it as `APP_SECRET` in `.env`:

```bash
openssl rand -hex 32
```

Do not commit `.env` or any production credentials to the repository.

### Start

Start PostgreSQL with pgvector using the included Compose service, and provide Redis separately:

```bash
docker compose up -d db
docker run -d --name akasha-redis -p 6379:6379 redis:7
```

Then apply migrations and start the development servers:

```bash
pnpm --filter ./apps/server run migration:latest
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000). For environment requirements, model configuration, service details, and troubleshooting, see [`docs/development.md`](./docs/development.md).

### Build

```bash
pnpm run build           # Build all workspace projects
pnpm run client:build    # Build the frontend
pnpm run server:build    # Build the backend
```

Build artifacts are generated under the corresponding `apps/*/dist` and `packages/*/dist` directories.

## Agent Integration

Akasha provides an MCP endpoint for agents to access the knowledge workspace.

Configure the MCP server with:

- the absolute URL of the deployed Akasha instance followed by `/mcp`;
- an API key with the required workspace permissions.

The MCP integration supports knowledge queries and permitted operations on pages, spaces, comments, attachments, and workspace information. Requests follow Akasha's authorization rules.

See [`akasha-plugin/README.md`](./akasha-plugin/README.md) for installation instructions and host-specific configuration examples.

## Self-hosted

Akasha is designed to run in self-hosted environments. Organizations can control where application data, file storage, and AI model endpoints are configured, while applying their own access-control and operational policies.

## Acknowledgements

Akasha builds upon excellent open-source projects. We gratefully acknowledge:

- **[Docmost](https://github.com/docmost/docmost)** — the collaborative Wiki foundation that the workspace and editor layers build on.

## Contributors

Thank you for your contribution!
Please refer to the [Contribution Guide](./CONTRIBUTING.md) for more information.
