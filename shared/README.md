# shared/

Code both the client (`client/`, bundled by Vite) and the server (`server/`,
run by tsx) import, so a protocol constant, type or validator exists once.

- The client imports it as `@shared/<file>` (a Vite alias and a tsconfig path).
- The server imports it by relative path, as `../shared/<file>.js`.
- It runs in both a browser and Node: no DOM, no `Buffer`, no `node:` modules,
  no npm dependencies. Where the two differ (SHA-256), each side passes its own in.
- The image copies it next to `client/` and `server/` (`deploy/Dockerfile`).

`plugin/` is the plugin system's contract: the manifest validator
(`manifest.ts`), plugin sources and the ids derived from them (`sources.ts`),
version ranges (`semver.ts`) and the frame ↔ host message protocol
(`protocol.ts`). It is also what a standalone plugin checker is built from, so
it stays free of anything app-specific.
