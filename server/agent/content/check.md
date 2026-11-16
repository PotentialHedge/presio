---
title: Presio PDF sidecar checker
description: Validate Presio speaker-notes and media sidecar attachments embedded in a PDF.
canonical: BASE/check
last_updated: 2026-11-16
---

# PDF sidecar checker

Upload a Presio PDF to validate embedded speaker notes and media sidecars.

## UI

Open BASE/check for thumbnails and per-page validity.

## API

```bash
curl -s -F file=@deck.pdf BASE/api/check | jq .
```

Schema: BASE/schema/check-report.schema.json

Notes attachments: `notes-slide-{N}.json`
Media: `media-slide-{N}-{id}.json` plus optional binary `media-*.{gif,mp4,webm}`.
HTML animations (`"kind": "html"`): the page as `media-{id}.html`, and each
file it loads as a `media-asset-…` attachment listed in the sidecar's
`assets` (`{ "path": "js/app.js", "filename": "media-asset-…" }`). Options:
`sync` (`"presenter"` | `"independent"`), `controls`, `interactive`,
`duration` (seconds), `poster_at` (seconds; the frame used as its preview).
What the presenter changes on the page reaches viewers following them: form
fields by themselves, other state when the page calls
`presio.sync({ get: () => data, set: (data) => {} })`. Full schema: BASE/schema/media-sidecar.schema.json

## Sitemap

- [Home](BASE/)
- [Checker](BASE/check)
- [Glossary](BASE/glossary.md)
- [Full index](BASE/sitemap.md)
