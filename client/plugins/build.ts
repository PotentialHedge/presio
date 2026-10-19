// Built-in plugins written in TypeScript (+ React). Each client/plugins/<name>/
// holds a presio-plugin.json and a main.tsx or main.ts; this builds it as ES
// modules served at /plugins/<name>/ beside its manifest — built on request by
// the dev server, emitted into dist by `vite build`.
//
// The build is split, not one file: index.html only loads the entry script,
// and whatever the entry imports dynamically — a surface's own code, pdf-lib
// for a download — is a separate chunk fetched only by the frames that need
// it. So a viewer never downloads the presenter's code. Chunk names carry a
// content hash (the server caches them for good); the frame resolves the
// relative URLs against the plugin's own folder (its <base>, see
// plugin-frame.html).

import fs from "fs"
import path from "path"
import { build, type Plugin } from "vite"
import react from "@vitejs/plugin-react"

const ROOT = import.meta.dirname
const URL_RE = /^\/plugins\/([a-z0-9-]+)\/([A-Za-z0-9._-]+)$/

function pluginNames(): string[] {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, "presio-plugin.json")))
    .map((d) => d.name)
}

function entry(name: string): string {
  const tsx = path.join(ROOT, name, "main.tsx")
  return fs.existsSync(tsx) ? tsx : path.join(ROOT, name, "main.ts")
}

/** One plugin's files, by name relative to its folder: index.html, the
 *  manifest, and the scripts and styles it loads. */
async function bundle(name: string, dev: boolean): Promise<Map<string, string | Uint8Array>> {
  const result = await build({
    configFile: false,
    envDir: false,
    root: path.join(ROOT, name),
    // Relative, so chunks find each other and their CSS under the plugin's
    // own folder wherever that is served.
    base: "./",
    logLevel: "warn",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    build: {
      write: false,
      minify: !dev,
      modulePreload: false,
      rollupOptions: {
        input: entry(name),
        output: {
          format: "es",
          entryFileNames: "main-[hash].js",
          chunkFileNames: "[name]-[hash].js",
          assetFileNames: "[name]-[hash][extname]",
        },
      },
    },
  })
  const files = new Map<string, string | Uint8Array>()
  let main = ""
  const styles: string[] = []
  for (const out of (Array.isArray(result) ? result : [result]).flatMap((r) => ("output" in r ? r.output : []))) {
    if (out.type === "chunk") {
      files.set(out.fileName, out.code)
      if (out.isEntry) {
        main = out.fileName
        // CSS the entry imports: linked from index.html, so it applies before
        // the first render instead of flashing in.
        styles.push(...(out.viteMetadata?.importedCss ?? []))
      }
    } else {
      files.set(out.fileName, out.source)
    }
  }
  files.set(
    "index.html",
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${styles.map((href) => `<link rel="stylesheet" href="${href}">`).join("\n")}
</head>
<body>
<div id="root"></div>
<script type="module" src="${main}"></script>
</body>
</html>
`
  )
  files.set("presio-plugin.json", fs.readFileSync(path.join(ROOT, name, "presio-plugin.json"), "utf8"))
  return files
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".json": "application/json",
  ".js": "text/javascript",
  ".css": "text/css",
}

export function builtinPlugins(): Plugin {
  // Dev: each plugin's latest build, redone whenever its index.html is asked
  // for (so a reload picks up edits); its chunks are served from here.
  const latest = new Map<string, Map<string, string | Uint8Array>>()
  return {
    name: "presio-builtin-plugins",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = URL_RE.exec((req.url ?? "").split("?")[0])
        if (!match || !pluginNames().includes(match[1])) return next()
        const [, name, file] = match
        const files =
          file === "index.html" || !latest.has(name)
            ? bundle(name, true).then((built) => (latest.set(name, built), built))
            : Promise.resolve(latest.get(name)!)
        files.then(
          (built) => {
            const body = file === "presio-plugin.json"
              ? fs.readFileSync(path.join(ROOT, name, "presio-plugin.json"), "utf8")
              : built.get(file)
            if (body === undefined) return next()
            res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream")
            res.setHeader("Cache-Control", "no-cache")
            res.end(body)
          },
          (err) => next(err)
        )
      })
    },
    async generateBundle() {
      for (const name of pluginNames()) {
        for (const [file, source] of await bundle(name, false)) {
          this.emitFile({ type: "asset", fileName: `plugins/${name}/${file}`, source })
        }
      }
    },
  }
}

// What a plugin's author needs besides the docs: the checker, bundled from
// kit/check.ts with the shared validator into one dependency-free Node
// script, and the API's types. The template is plain files in
// public/plugins/template/.
const KIT_FILES: Record<string, () => Promise<string>> = {
  "plugins/check.mjs": bundleChecker,
  "sdk/v1/presio.d.ts": async () => fs.readFileSync(path.join(ROOT, "sdk", "presio.d.ts"), "utf8"),
}

async function bundleChecker(): Promise<string> {
  const result = await build({
    configFile: false,
    envDir: false,
    logLevel: "warn",
    build: {
      write: false,
      ssr: path.join(ROOT, "kit", "check.ts"),
      target: "node18",
      minify: false,
      rollupOptions: { output: { format: "es", entryFileNames: "check.mjs" } },
    },
  })
  const chunk = (Array.isArray(result) ? result : [result])
    .flatMap((r) => ("output" in r ? r.output : []))
    .find((o) => o.type === "chunk" && o.isEntry)
  if (!chunk || chunk.type !== "chunk") throw new Error("The plugin checker didn't build")
  return `#!/usr/bin/env node\n${chunk.code}`
}

export function pluginKit(): Plugin {
  return {
    name: "presio-plugin-kit",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = (req.url ?? "").split("?")[0].slice(1)
        const make = KIT_FILES[file]
        if (!make) return next()
        make().then(
          (body) => {
            res.setHeader("Content-Type", file.endsWith(".mjs") ? "text/javascript" : "text/plain; charset=utf-8")
            res.setHeader("Cache-Control", "no-cache")
            res.end(body)
          },
          (err) => next(err)
        )
      })
    },
    async generateBundle() {
      for (const [fileName, make] of Object.entries(KIT_FILES)) {
        this.emitFile({ type: "asset", fileName, source: await make() })
      }
    },
  }
}
