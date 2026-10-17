/// <reference types="vitest/config" />
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { builtinPlugins } from './plugins/build'

// Bake the built asset list into the shipped service worker so a fresh install
// precaches the whole app up front. The pdf.js worker and its wasm helper are
// separate chunks that aren't fetched until the first PDF renders, so caching
// on demand leaves an installed-then-offline app unable to open a deck.
function precacheServiceWorker(): Plugin {
  let outDir = ""
  return {
    name: "presio-sw-precache",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const swPath = path.join(outDir, "sw.js")
      if (!fs.existsSync(swPath)) return

      const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const full = path.join(dir, entry.name)
          return entry.isDirectory() ? walk(full) : [full]
        })

      // "/" stands in for index.html, which is what a navigation asks for and
      // what the fetch handler falls back to.
      const assets = walk(outDir)
        .map((file) => "/" + path.relative(outDir, file).split(path.sep).join("/"))
        .filter((url) => url !== "/sw.js" && url !== "/index.html")
        .sort()
      const manifest = ["/", ...assets]

      // Content-derived so a deploy that changes nothing keeps its cache, and
      // any real change makes a new one that `activate` sweeps the old into.
      const buildId = crypto
        .createHash("sha256")
        .update(manifest.join("\n"))
        .update(fs.readFileSync(path.join(outDir, "index.html")))
        .digest("hex")
        .slice(0, 12)

      const sw = fs
        .readFileSync(swPath, "utf8")
        .replace('"__BUILD_ID__"', JSON.stringify(buildId))
        .replace('"__PRECACHE_MANIFEST__"', JSON.stringify(manifest))
      fs.writeFileSync(swPath, sw)
    },
  }
}

// Dev only: try the app/viewer origin split (lib/origins.ts) without a
// deployment, e.g. DEV_VIEWER_ORIGIN=http://127.0.0.1:5173 with the app on
// http://localhost:5173. The server names the two in production; here the
// dev server does. Unset, dev stays on one origin, as LAN testing needs.
function devOrigins(): Plugin {
  const viewer = process.env.DEV_VIEWER_ORIGIN
  const app = process.env.DEV_APP_ORIGIN ?? "http://localhost:5173"
  return {
    name: "presio-dev-origins",
    apply: "serve",
    transformIndexHtml() {
      if (!viewer) return
      return [
        { tag: "meta", attrs: { name: "presio-app-origin", content: app }, injectTo: "head" },
        { tag: "meta", attrs: { name: "presio-viewer-origin", content: viewer }, injectTo: "head" },
      ]
    },
  }
}

export default defineConfig({
  plugins: [react(), builtinPlugins(), devOrigins(), precacheServiceWorker()],
  build: {
    // Keep in step with "browserslist" in package.json (read by
    // eslint-plugin-compat and scripts/check-compat.mjs). This lowers syntax
    // only; missing APIs are polyfilled in src/polyfills.ts.
    target: ["chrome109", "edge109", "firefox115", "safari16.4"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Code the server imports too (see shared/README.md).
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  server: {
    // shared/ is outside the client's root, which the dev server otherwise
    // refuses to serve from.
    fs: { allow: [".", "../shared"] },
    proxy: {
      "/api": "http://localhost:3001",
      // Local mode's uploaded decks (server/local/blobStore.ts).
      "/files": "http://localhost:3001",
      "/mcp": "http://localhost:3001",
      "/.well-known": "http://localhost:3001",
      "/llms.txt": "http://localhost:3001",
      "/llms-full.txt": "http://localhost:3001",
      "/robots.txt": "http://localhost:3001",
      "/sitemap.xml": "http://localhost:3001",
      "/sitemap.md": "http://localhost:3001",
      "/AGENTS.md": "http://localhost:3001",
      "/api.md": "http://localhost:3001",
      "/openapi.json": "http://localhost:3001",
      "/index.md": "http://localhost:3001",
      "/check.md": "http://localhost:3001",
      "/plugins.md": "http://localhost:3001",
      "/schema": "http://localhost:3001",
      "/socket.io": {
        target: "http://localhost:3001",
        ws: true,
      },
    },
  },
  test: {
    // Default to a node environment; DOM-dependent tests opt in per-file with
    // a `// @vitest-environment happy-dom` comment.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
