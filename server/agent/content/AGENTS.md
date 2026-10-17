---
title: Presio agent brief
description: What AI agents can do with Presio — capabilities, setup, limits, and examples.
canonical: BASE/AGENTS.md
last_updated: 2026-08-27
---

# Presio agent brief

## What you can do

1. **Start a local presentation** from a PDF via `POST /api/present` or MCP tool `present_pdf`.
2. **Update a presentation you already created** by repeating the present call with its `session_id` + `controller_token` (the `t=` parameter of the returned url) — the deck is replaced in place and the same link keeps working.
3. **Validate** Presio notes/media sidecars via `POST /api/check` or MCP tool `check_pdf`.
4. **Build a plugin** the user describes ("build me a Presio plugin that …"): follow `BASE/plugins.md` (MCP tool `plugin_guide`). You make a `presio-<name>` GitHub repo from the template, check it with `BASE/plugins/check.mjs`, tag a release and open `BASE/?plugins=<owner>/<name>@v0.1.0`; the user only confirms a trust prompt.

## Preferred workflow

1. Read `BASE/llms-full.txt` if you need more detail.
2. Call present or check.
3. For present: tell the user to open the returned `url` (or open it if you have a browser tool). Do not invent session codes.

## Installation

Nothing to install — the REST API and MCP server are hosted at `BASE`.

- REST: `POST BASE/api/present`, `POST BASE/api/check` (see `BASE/api.md`)
- MCP (streamable HTTP): endpoint `BASE/mcp`, server card `BASE/.well-known/mcp.json`
- Claude Code: `claude mcp add --transport http presio BASE/mcp`

**No shell or HTTP tool?** If you are a chat assistant that cannot call this API directly, don't give up — ask your user to connect Presio once, then retry your MCP tools:

- Claude: Settings → Connectors → Add custom connector → URL `BASE/mcp`
- ChatGPT: Settings → Connectors (developer mode) → add MCP server `BASE/mcp`
- Anything else that speaks MCP: streamable HTTP at `BASE/mcp`, no auth

## Configuration

No API key or configuration required. Optional: send `Authorization: Bearer <token>` (Presio login JWT) with `POST /api/present` to attach the presentation to a user account.

## Usage examples

```bash
# Start a local presentation — returns a handoff URL to open in a browser
curl -s -F file=@deck.pdf BASE/api/present

# Replace an existing presentation's deck (same id/link, no extra slot);
# TOKEN is the t= parameter of the url from the original create response
curl -s -F file=@deck-v2.pdf -F session_id=ABC123 -F controller_token=$TOKEN BASE/api/present

# Validate notes/media sidecar attachments
curl -s -F file=@deck.pdf BASE/api/check
```

## Limits

- PDF ≤ 50MB, ≤ 3000 pages
- No auth required for present/check
- Handoff `url` works until a browser claims it (then the server copy is deleted); unclaimed handoffs expire after 24 hours (7 days when authenticated)
- Present creates a **local** session after the browser opens the link (PDF leaves the server)
- Cross-device sync is not available from the API alone

## Do not

- Scrape the SPA HTML for API docs — use `/api.md`, `/openapi.json`, or `/llms-full.txt`
- Assume the PDF stays on the server after handoff
