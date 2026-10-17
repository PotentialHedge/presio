import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type express from "express";
import { canonicalBaseUrl } from "../lib/baseUrl.js";
import { buildOpenApi } from "../agent/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.join(__dirname, "../agent/content");

const CACHE = "public, max-age=300";

// Sitemap lastmod: newest content file, set at image build time (git checkout).
const LASTMOD = (() => {
  const times = fs
    .readdirSync(CONTENT)
    .map((f) => fs.statSync(path.join(CONTENT, f)).mtime.getTime());
  return new Date(Math.max(...times)).toISOString().slice(0, 10);
})();

function readContent(name: string): string {
  return fs.readFileSync(path.join(CONTENT, name), "utf8");
}

function withBase(text: string, base: string): string {
  return text.replaceAll("BASE", base);
}

/** One of the agent docs, with its links pointing at `base`. */
export function agentDoc(name: "plugins.md", base: string): string {
  return withBase(readContent(name), base);
}

function sendText(res: express.Response, type: string, body: string, canonical?: string) {
  res.setHeader("Content-Type", `${type}; charset=utf-8`);
  res.setHeader("Cache-Control", CACHE);
  if (canonical) res.setHeader("Link", `<${canonical}>; rel="canonical"`);
  res.send(body);
}

function prefersMarkdown(req: express.Request): boolean {
  const accept = req.get("accept") || "";
  if (!accept.includes("text/markdown")) return false;
  // Browsers navigating for HTML send text/html first; don't override those.
  const htmlIdx = accept.indexOf("text/html");
  const mdIdx = accept.indexOf("text/markdown");
  if (htmlIdx === -1) return true;
  return mdIdx !== -1 && mdIdx < htmlIdx;
}

// sitemap.xml lists only canonical HTML pages — listing markdown mirrors and
// discovery files there makes crawlers judge them as pages (and fail them on
// HTML metadata checks). The full machine-readable index is sitemap.md.
const HTML_PAGE_PATHS = ["/", "/check"];

const SITEMAP_PATHS = [
  "/",
  "/check",
  "/index.md",
  "/check.md",
  "/llms.txt",
  "/llms-full.txt",
  "/AGENTS.md",
  "/api.md",
  "/glossary.md",
  "/plugins.md",
  "/plugins/check.mjs",
  "/plugins/template/presio-plugin.json",
  "/sdk/v1/presio.d.ts",
  "/openapi.json",
  "/robots.txt",
  "/sitemap.xml",
  "/sitemap.md",
  "/.well-known/mcp.json",
  "/.well-known/api-catalog",
];

export function registerAgentDocRoutes(app: express.Express) {
  app.get("/llms.txt", (req, res) => {
    const type = prefersMarkdown(req) ? "text/markdown" : "text/plain";
    sendText(res, type, withBase(readContent("llms.txt"), canonicalBaseUrl(req)));
  });

  app.get("/llms-full.txt", (req, res) => {
    const type = prefersMarkdown(req) ? "text/markdown" : "text/plain";
    sendText(res, type, withBase(readContent("llms-full.txt"), canonicalBaseUrl(req)));
  });

  for (const name of ["AGENTS.md", "api.md", "index.md", "check.md", "glossary.md", "plugins.md"] as const) {
    app.get(`/${name}`, (req, res) => {
      const base = canonicalBaseUrl(req);
      sendText(res, "text/markdown", withBase(readContent(name), base), `${base}/${name}`);
    });
  }

  // Scanners derive a page's markdown mirror as `${path}.md`, which for the
  // root is "/.md" — alias it to index.md so they don't get the SPA shell.
  app.get("/.md", (req, res) => {
    const base = canonicalBaseUrl(req);
    sendText(res, "text/markdown", withBase(readContent("index.md"), base), `${base}/index.md`);
  });

  app.get("/openapi.json", (req, res) => {
    res.setHeader("Cache-Control", CACHE);
    res.json(buildOpenApi(canonicalBaseUrl(req)));
  });

  app.get("/robots.txt", (req, res) => {
    const base = canonicalBaseUrl(req);
    const body = [
      "# AI agents: see /llms.txt for how to use Presio",
      "User-agent: *",
      "Allow: /",
      "",
      `Sitemap: ${base}/sitemap.xml`,
      "",
    ].join("\n");
    sendText(res, "text/plain", body);
  });

  app.get("/sitemap.xml", (req, res) => {
    const base = canonicalBaseUrl(req);
    const urls = HTML_PAGE_PATHS.map(
      (p) => `  <url>\n    <loc>${base}${p === "/" ? "/" : p}</loc>\n    <lastmod>${LASTMOD}</lastmod>\n  </url>`
    ).join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", CACHE);
    res.send(xml);
  });

  app.get("/sitemap.md", (req, res) => {
    const base = canonicalBaseUrl(req);
    const lines = [
      "# Sitemap",
      "",
      ...SITEMAP_PATHS.map((p) => `- [${p}](${base}${p === "/" ? "/" : p})`),
      "",
    ];
    sendText(res, "text/markdown", lines.join("\n"), `${base}/sitemap.md`);
  });

  // RFC 9727 API catalog: linkset pointing agents at the OpenAPI spec and docs.
  app.get("/.well-known/api-catalog", (req, res) => {
    const base = canonicalBaseUrl(req);
    res.setHeader("Content-Type", "application/linkset+json");
    res.setHeader("Cache-Control", CACHE);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(
      JSON.stringify({
        linkset: [
          {
            anchor: `${base}/api`,
            "service-desc": [{ href: `${base}/openapi.json`, type: "application/openapi+json" }],
            "service-doc": [{ href: `${base}/api.md`, type: "text/markdown" }],
          },
        ],
      })
    );
  });

  // Content negotiation: Prefer markdown mirrors when Accept says so.
  for (const [route, file] of [
    ["/", "index.md"],
    ["/check", "check.md"],
  ] as const) {
    app.get(route, (req, res, next) => {
      if (!prefersMarkdown(req)) return next();
      const base = canonicalBaseUrl(req);
      sendText(res, "text/markdown", withBase(readContent(file), base), `${base}/${file}`);
    });
  }
}
