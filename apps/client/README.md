# Akasha Client

React 18 + Vite single-page application: the collaborative editor (Tiptap via
`@docmost/editor-ext`), spaces and pages, knowledge search and answers, the
relationship graph, and the admin settings used to configure models.

Vite loads its environment from the repository root `.env` (not from this
directory), so `APP_URL`, `BACKEND_URL`, `COLLAB_URL`, and the upload limits
are read from the same file as the server. If you have not created one yet, copy
`.env.example` in the repository root.

## Develop

```bash
pnpm --filter ./apps/client run dev    # http://127.0.0.1:3000
```

The dev server proxies `/api`, `/mcp`, `/socket.io`, and `/collab` to
`BACKEND_URL`. The API process serves the collaboration WebSocket at `/collab`, so
real-time editing works without any extra process; set `COLLAB_URL` only when
collaboration runs on a different origin. See
[`docs/development.md`](../../docs/development.md).

## Scripts

| Script | Purpose |
| --- | --- |
| `dev` | Vite dev server with HMR |
| `build` | Type-check, then emit the production bundle to `dist` |
| `preview` | Serve the built bundle |
| `lint` / `format` | ESLint / Prettier |
| `test` / `test:watch` | Vitest suites |

## Layout

| Path | Contents |
| --- | --- |
| `src/features` | Feature modules (pages, spaces, editor, knowledge, AI settings) |
| `src/components` | Shared UI components |
| `src/pages` | Route-level pages |
| `src/lib` | Runtime config, API client, utilities |
| `src/ee` | Enterprise-only screens |
| `src/i18n.ts` | Translation loading |

UI primitives come from Mantine, server state from TanStack Query. Build artifacts
are produced in `apps/client/dist`.
