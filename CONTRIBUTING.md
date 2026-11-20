# Contributing to Akasha

Thanks for your interest in improving Akasha. This guide covers how to set up the
repository, run the checks maintainers expect, and submit a change that fits the
codebase.

## Ways to contribute

- Report bugs with reproduction steps and the affected version.
- Propose features or design changes in an issue before writing code.
- Fix bugs, add tests, or improve documentation.
- Improve retrieval, compilation, or benchmark quality with measurable results.

## Before you start

- Read [`docs/development.md`](./docs/development.md) for the full local setup.
- Bug fixes and features should reference an issue when one exists.
- Security issues must follow [`SECURITY.md`](./SECURITY.md) and must not be filed
  as public issues.

## Workflow

1. Fork <https://github.com/chaterm/Akasha> and clone your fork.
2. Create a topic branch from `beta`, for example `fix/page-move-cycle`.
3. Make the change, run the checks listed below, and keep the diff focused.
4. Open a pull request against `beta`. `main` is the release branch that
   maintainers update from `beta`; do not target it directly.
5. Link the issue in the pull request description and describe the behaviour
   before and after the change.

## Local setup

Requirements: Node.js 22 or later, pnpm 10.4.0 (the version pinned in
`package.json`), Docker, and Python 3 only if you package the agent skills.

```bash
pnpm install
cp .env.example .env
openssl rand -hex 32       # write the result into APP_SECRET

docker compose up -d db    # PostgreSQL 18 + pgvector + pg_jieba
docker run -d --name akasha-redis -p 6379:6379 redis:7

pnpm --filter ./apps/server run migration:latest
pnpm run dev               # client on :3000, server on :8080
```

Real-time collaboration is served by the API process itself, so `pnpm run dev` is
enough. `pnpm run collab:dev` runs the optional standalone collaboration server; see
[`docs/development.md`](./docs/development.md#collaboration-server).

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/server` | NestJS API, MCP endpoint, knowledge compilation and retrieval, collaboration server |
| `apps/client` | React 18 + Vite + Mantine web client |
| `packages/editor-ext` | Tiptap editor extensions shared by client and server |
| `benchmark` | Local evaluation platform (FastAPI + React) for retrieval and answer quality |
| `akasha-plugin` | Agent skills, host metadata, and the offline skill package |
| `docs` | Development setup and API references |

## Checks

Run the checks that cover the area you changed. All of them should pass before a
pull request is reviewed.

```bash
pnpm run build                                  # all workspace projects
pnpm --filter ./apps/server run lint
pnpm --filter ./apps/server run test            # jest
pnpm --filter ./apps/client run lint
pnpm --filter ./apps/client run test            # vitest
(cd benchmark && make test)                     # pytest for the evaluation platform
```

Formatting uses Prettier; `pnpm --filter ./apps/server run format` and
`pnpm --filter ./apps/client run format` rewrite source files in place.

## Code conventions

- TypeScript in both applications. Follow the types used by the surrounding
  module instead of widening to `any`, and keep new code compatible with the
  existing `tsconfig` settings rather than relaxing them.
- Server logging passes a leading object and a constant message. Template
  literals as the first argument are rejected by ESLint
  (`apps/server/eslint.config.mjs`):

  ```ts
  logger.warn({ pageId, err }, 'Failed to update page');
  ```

- Database changes go in `apps/server/src/database/migrations` as ordered SQL
  migrations. Run `migration:create` to scaffold one and `migration:latest` to
  apply it; do not edit migrations that have already shipped.
- Changes to the addressable node types
  (`packages/editor-ext/src/lib/unique-id/addressable-types.ts`) must be
  regenerated on both sides: run
  `pnpm --filter ./apps/server run skill:node-reference` and commit the updated
  `akasha-plugin/skills/akasha-pages/references/node-reference.md`.
- Changes under `akasha-plugin/skills` must be packaged:
  `make skills-zip` (or `python3 akasha-plugin/scripts/package-skills.py`) and
  `make skills-verify` before committing.

## Commit messages

Use Conventional Commits. Scope is optional but encouraged:

```text
feat(mcp): add edit_page for node-level page edits
fix(llm-wiki): stop showing a stale error on a settled run page
docs: document the pg_jieba requirement
test(client): raise testing-library asyncUtilTimeout
```

## Documentation

Keep documentation in sync with behaviour:

- Local setup, prerequisites, and troubleshooting: `docs/development.md`.
- iself integration API contracts: `docs/iself-agent-api-key.yaml` and
  `docs/iself-llm-wiki-query.yaml`.
- Skill behaviour, tool contracts, and packaging: `akasha-plugin/README.md` and
  the relevant `SKILL.md`.
- Benchmark pipeline and data model: `benchmark/docs/architecture.md`.

## License

By contributing, you agree that your contributions are licensed under the
GNU Affero General Public License v3.0, the same terms as the project
([`LICENSE`](./LICENSE)).
