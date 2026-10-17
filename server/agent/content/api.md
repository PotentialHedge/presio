---
title: Presio API
description: REST reference for starting local PDF presentations and validating sidecars, with curl examples.
canonical: BASE/api.md
last_updated: 2026-10-17
---

# Presio API

Base URL: `BASE`

## POST /api/present

Upload a PDF to start a local presentation. Returns a URL to open in a browser (skips share).

- Content-Type: `multipart/form-data`
- Field: `file` (PDF)
- Auth: optional Bearer

```bash
curl -s -F file=@deck.pdf BASE/api/present
```

**200:** `{ id, url, filename, totalSlides, next }`

- `url` — handoff link. Open it → PDF moves into the browser as a local session; the server copy is then deleted and the link stops working. Fetching the URL without completing handoff does not consume it.
- Unclaimed handoffs expire after **24 hours** (7 days when authenticated).
- `filename` — display title: the uploaded filename with its `.pdf` extension stripped.

## Updating an existing presentation

To replace an existing presentation's deck instead of creating a new one, repeat `POST /api/present` with two extra multipart fields:

- `session_id` — the presentation's id (`id` from the original create response)
- `controller_token` — that presentation's controller token, taken from the **`t=` query parameter of the `url` returned when it was created**. The same value may instead be sent as an `x-controller-token` header.

The deck is replaced in place: the response keeps the **same `id` and the same `url`** as the original response, and no additional concurrent-presentation slot is used — you can iterate on slides without minting a fresh URL each pass or hitting the concurrent cap. If the browser has already completed handoff for this session, resending the link pulls the updated deck into it — the handoff link revives with the new deck.

Send `session_id` and `controller_token` **at most once each**; a repeated field is rejected with 400 rather than guessed at.

```bash
curl -s -F file=@deck-v2.pdf \
  -F session_id=ABC123 -F controller_token=TOKEN \
  BASE/api/present
```

**200:** `{ id, url, filename, totalSlides, next, updated: true }` — `url` is unchanged from the original response. For a deck that has been synced for sharing, that `url` is the viewer link (`BASE/s/:id`), which carries no token; live viewers reload the new slides automatically.

Errors: **400** if `session_id` or `controller_token` is sent more than once, **401** if `session_id` is given without a token, **403** on a wrong token (you cannot overwrite someone else's presentation), **404** when the id is unknown or the session has expired — no new presentation is silently created in any of these cases.

The upload itself is validated the same way as on create: **400** for a non-PDF or an over-length deck, **413** over 50MB, **422** for bytes that will not parse as a PDF.

## POST /api/check

Validate Presio sidecar attachments (notes + media).

```bash
curl -s -F file=@deck.pdf BASE/api/check
```

**200:** CheckReport JSON (see `BASE/schema/check-report.schema.json`)

## GET /api/plugins

Published plugins: public GitHub repos with the `presio-plugin` topic, most starred first. The server searches GitHub at most every 5 minutes and serves everyone from that.

```bash
curl -s BASE/api/plugins | jq '.plugins[] | {source, description}'
```

**200:** `{ plugins: [{ source, id, owner, repo, description, stars, pushedAt, htmlUrl, avatarUrl, topics }], fetchedAt }`. Load one with `BASE/?plugins=<source>` (add `@<tag>` to pin a release). **502** when GitHub can't be searched and nothing is cached yet.

## Handoff (used by the start page)

- `GET /api/sessions/:id/handoff?t=TOKEN` — download staged PDF
- `POST /api/sessions/:id/handoff/complete` — header `x-controller-token` — clear server copy

## Account presentations

- `GET /api/sessions/mine` — header `Authorization: Bearer <login JWT>` — the signed-in user's live synced presentations, newest first.
  **200:** `[{ id, filename, total_slides, created_at, expires_at, controllerToken }]`. `controllerToken` is included because the owner is entitled to it — it lets any device the user signs in on open the presentation as its controller. 401 without a valid token; not available in local mode.
- `DELETE /api/sessions/:id` — header `x-controller-token` — end a presentation: viewers are disconnected, the PDF is removed, and the row is marked expired (not recoverable).

## URL-backed decks (republish detection)

Presentations created with `POST /api/sessions/external` point at a PDF hosted elsewhere. A running session can detect that the file at the source URL was republished and swap it in live, without re-uploading anything.

- `GET /api/sessions/:id/remote-version` — header `x-controller-token` (or `Authorization: Bearer <login JWT>` for the owner) — cheap change detection for a URL-backed deck. The server probes the deck's source URL with a HEAD request (a one-byte ranged GET for hosts that reject HEAD) and returns the validator tuple:
  **200:** `{ etag, lastModified, contentLength }` — each field an opaque string, `""` when the host does not send it. Nothing is downloaded.
  - **404** when the session is unknown or expired, or is **not URL-backed** (local and server-hosted decks have no `pdf_url`) — treat this as "nothing to watch".
  - **502** when the remote host is unreachable or errors, or when the URL is one the server refuses to fetch — back off and retry later; the session keeps working with its current deck.
  - **403** on a wrong controller token.

  The probe is https-only and restricted to public addresses: a `pdf_url` that resolves to a loopback, private, link-local or otherwise internal address is refused, and redirects are followed only while they stay https and public. A deck hosted somewhere only reachable inside a private network can be presented as normal — it just gets no republish detection.
- `POST /api/sessions/:id/deck-refreshed` — same auth — the presenter accepted a republished deck. Body: `{ "total_slides": N }` (the new page count, read from the republished PDF). Records the new page count, clamps the stored current slide into range, drops the stored drawings, and broadcasts `deck_updated` to the room so every connected client re-fetches the source URL.
  **200:** `{ ok: true, totalSlides, filename }`. **400** for a missing/invalid `total_slides` or a presentation that is not URL-backed. No bytes are uploaded — `pdf_url` decks keep no server copy.

## OpenAPI

Machine-readable: `BASE/openapi.json`

## MCP

`BASE/mcp` — tools `present_pdf`, `check_pdf`

`present_pdf` accepts the same update flow: pass `session_id` + `controller_token` (the `t=` parameter of the url from the original create response) to replace that deck in place and get the same link back.
