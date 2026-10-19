# AGENTS.md

Coding agents working in this repository.

## Project

**Presio** — PDF presentation app (local-by-default + optional online sync).

- `client/` — Vite + React SPA
- `server/` — Express + Socket.IO + Supabase
- `schema/` — JSON schemas for sidecar formats

## Agent-facing product APIs (runtime)

These are served live by the Express app (not static files):

| Path | Purpose |
|------|---------|
| `/llms.txt` | Agent index |
| `/llms-full.txt` | Present + check playbook |
| `/AGENTS.md` | Product agent brief |
| `/api.md` / `/openapi.json` | API docs |
| `/plugins.md` | Building a plugin: agent workflow, manifest, `window.presio` API |
| `/plugins/template/`, `/plugins/check.mjs`, `/sdk/v1/presio.d.ts` | Plugin template, checker and API types (built by `client/plugins/build.ts`) |
| `/robots.txt` / `/sitemap.xml` | Crawl discovery |
| `/.well-known/mcp.json` / `/mcp` | MCP tools `present_pdf`, `check_pdf`, `plugin_guide` |
| `POST /api/present` | Upload PDF → local handoff URL (update in place with `session_id` + controller token) |
| `POST /api/check` | Sidecar validity report |

Sources: `server/agent/content/`, `server/routes/agentDocs.ts`, `server/routes/mcp.ts`, `server/lib/presentHandoff.ts`.

Plugins: `client/public/plugin-frame.html` (frame + `window.presio` runtime), `client/src/lib/plugins/` (host), `client/plugins/` (built-in plugins in TS/React, bundled by `client/plugins/build.ts`), `client/public/plugins/` (plugin template), relay in `server/socket/plugins.ts`.

## Dev

```bash
cd server && npm run dev   # API (needs env / Supabase)
cd client && npm run dev   # SPA
```

`PRESIO_MODE=local npm run dev` runs the API against a bundled SQLite +
filesystem backend instead (`server/local/`), needing no env at all — no
Supabase, no auth. See `deploy/README.md` and `local.docker-compose.yml`.

## Conventions

- Prefer local presentations (IndexedDB); server upload only for sync/claim/handoff
- Do not add tests unless asked
- Keep changes focused; match existing style
