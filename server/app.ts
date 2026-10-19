import express from "express";
import fs from "fs";
import * as Sentry from "@sentry/node";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { fileURLToPath } from "url";
import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAllowedOrigins, buildCspDirectives, PLUGIN_FRAME_CSP } from "./security.js";
import { canonicalBaseUrl, originPair } from "./lib/baseUrl.js";
import { localBlobsDir } from "./local/paths.js";
import { isLocalMode } from "./local/mode.js";
import { registerSessionRoutes } from "./routes/sessions/index.js";
import { registerHistoryRoutes } from "./routes/history.js";
import type { HistoryBucket } from "./history.js";
import { registerNewsletterRoutes } from "./routes/newsletter.js";
import { registerCheckRoute } from "./routes/check.js";
import { registerLanAddressRoute } from "./routes/lanAddress.js";
import { registerAgentDocRoutes } from "./routes/agentDocs.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import type { SocketState } from "./socket.js";
import { APP_VERSION } from "./version.js";

export interface AppDeps {
  supabase: SupabaseClient;
  io: Server;
  socketState?: SocketState;
}

export function createApp({ supabase, io, socketState }: AppDeps): express.Express {
  const app = express();

  // Exactly one reverse-proxy hop (Traefik) sits in front in production, so
  // trust one level of X-Forwarded-*. This is what makes `req.protocol` report
  // the scheme the *browser* used rather than the plain HTTP of the last hop —
  // baseUrl() falls back to it when no public origin is configured, so without
  // this every generated link would come out `http://` on a deployment relying
  // on that fallback. Trusting more hops would let a client dictate those
  // headers itself. Local mode has no proxy in front, so set TRUST_PROXY=false
  // there.
  app.set("trust proxy", process.env.TRUST_PROXY === "false" ? false : 1);

  const allowedOrigins = getAllowedOrigins();
  // Development and local/LAN use have no fixed origin to configure ahead of
  // time — the client can be reached as localhost, a LAN IP, or a hostname
  // (e.g. `npm run dev` viewed from a phone/tablet on the same network), none
  // of which are known at startup. Accept any origin unless ALLOWED_ORIGIN was
  // set explicitly (which still takes priority).
  const devOrLocal = process.env.NODE_ENV === "development" || isLocalMode;
  const corsOrigin: cors.CorsOptions["origin"] =
    !allowedOrigins.length && devOrLocal
      ? true
      : (origin, callback) => {
          // No Origin header => same-origin / non-browser client (curl, server-to-server).
          if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
          // Deny by omitting the CORS headers rather than by erroring: the
          // browser blocks the response either way, but an Error here would
          // travel to the error handler as an unhandled 500 and be reported to
          // Sentry. Any stray page on the internet can point a fetch at us, so
          // that is unactionable noise, not a fault of ours.
          callback(null, false);
        };

  // Helmet for sensible security headers. The CSP allows the Supabase
  // API/storage and websocket connections (plugins get their own, below).
  app.use(
    helmet({
      contentSecurityPolicy: { directives: buildCspDirectives() },
      crossOriginEmbedderPolicy: false,
      // YouTube (esp. the JS API / nocookie player, in the media plugin's
      // frame) validates the embedding origin via the Referer header. Helmet's default `no-referrer` strips it,
      // which triggers YouTube playback error 153. Send the origin cross-site.
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    })
  );
  app.use(cors({ origin: corsOrigin }));

  // The plugin frame swaps the app's policy for its own permissive one (see
  // PLUGIN_FRAME_CSP). Set after helmet so it replaces, not joins, the app
  // policy — two policies would intersect and block the inline scripts.
  app.use("/plugin-frame.html", (_req, res, next) => {
    res.setHeader("Content-Security-Policy", PLUGIN_FRAME_CSP);
    next();
  });

  // There is deliberately no HTTP rate limiter here. Rate limiting belongs at
  // the edge: the app used to key one on `req.ip`, but with Cloudflare and then
  // Traefik in front, that address is the Cloudflare edge — so every visitor
  // behind a given edge shared one budget and a single busy user could throttle
  // strangers. The real client address only ever arrives in `Cf-Connecting-Ip`,
  // which is an ordinary spoofable header, so trusting it here would only be
  // sound because the origin refuses non-Cloudflare traffic — i.e. the edge is
  // already the enforcement point. Limiting there instead of here is both
  // correct per-visitor and one moving part fewer.
  //
  // Deployments that do NOT sit behind Cloudflare (self-hosted per
  // deploy/README.md, or PRESIO_MODE=local) therefore have no HTTP rate
  // limiting of their own — put it on whatever proxy or CDN fronts them.
  // Note this is not brute-force protection either way: the shared-control
  // passphrase is 8 characters over a 32-symbol alphabet (~2^40), and live
  // presenting (slide changes, laser, drawing) runs over Socket.IO rather than
  // HTTP, so it never passed through the limiter at all — see socket.ts.

  // The MCP tools (present_pdf / check_pdf) take the PDF base64-encoded inside
  // the JSON-RPC body, so /mcp needs a body limit in the same league as the
  // 50MB multipart cap on /api/present — base64 inflates by 4/3, hence 70mb.
  // Under express.json()'s 100kb default anything past ~75kB of PDF failed with
  // an HTML PayloadTooLargeError page, which MCP clients can't even parse as a
  // JSON-RPC error. Mounted before the global parser so it wins for this path.
  app.use("/mcp", express.json({ limit: "70mb" }));
  app.use(express.json());

  // Body-parser failures (oversized payload, malformed JSON) otherwise fall
  // through to Express's default handler, which renders an HTML error page — a
  // parse error for the JSON-RPC and REST clients these paths exist for. Sits
  // directly after the parsers so it only sees their errors.
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const status = (err as { status?: number })?.status;
    if (!status || status < 400 || status >= 500) return next(err);
    const message = status === 413 ? "Request body too large" : "Malformed request body";
    if (req.path === "/mcp") {
      res.status(status).json({ jsonrpc: "2.0", error: { code: -32600, message }, id: null });
      return;
    }
    res.status(status).json({ error: message });
  });

  // Liveness probe for uptime monitoring (Uptime Kuma). Outside /api so a probe
  // never counts against anything the edge meters, and intentionally cheap — it
  // doesn't touch the DB.
  app.get("/healthz", (_req, res) => {
    // `version` is here rather than on its own route so that the one URL
    // people already curl when a self-hosted deployment misbehaves also
    // answers "which build is this?".
    res.json({ status: "ok", uptime: process.uptime(), version: APP_VERSION });
  });

  // Live agent discovery docs (host-aware). Before static/SPA so they aren't
  // swallowed by index.html.
  registerAgentDocRoutes(app);

  registerSessionRoutes(app, { supabase, io, socketState });
  if (socketState) {
    socketState.history.setBucket(supabase.storage.from("presentations") as unknown as HistoryBucket);
    registerHistoryRoutes(app, { supabase, history: socketState.history });
  }
  registerNewsletterRoutes(app, supabase);
  registerCheckRoute(app);
  // Local/dev only: lets share surfaces resolve this machine's LAN address
  // instead of asking the presenter to type it (see lib/lanAddress.ts).
  registerLanAddressRoute(app, { enabled: devOrLocal });
  registerPluginRoutes(app);
  registerMcpRoutes(app, supabase, { io, socketState });

  // Unknown API paths must 404 as JSON — falling through to the SPA catch-all
  // returns index.html with a 200, which masks client bugs as parse errors.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Same for /.well-known: agent discovery scanners probe many protocols
  // (A2A, ACP, UCP, …) we don't implement; index.html with a 200 reads as a
  // corrupt discovery document, a 404 reads as "not supported".
  app.use("/.well-known", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // --- Serve client in production ---

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.join(__dirname, "../client/dist");

  // JSON schemas for the sidecar format — served at /schema/*.json
  // (A miss falls through to the SPA's catch-all, so don't let it.)
  app.use("/schema", express.static(path.join(__dirname, "../schema"), { index: false, fallthrough: false }));

  // Local mode's blob store (server/local/blobStore.ts) writes PDFs here and
  // hands back relative /files/... URLs. In Supabase mode this directory
  // never exists, so requests just fall through to the catch-all below.
  app.use("/files", express.static(localBlobsDir(), { index: false }));

  // index: false so "/" falls through to the catch-all below and gets its
  // canonical/og:url tags like every other route.
  // Built-in plugins (client/plugins/build.ts): their chunks are named by
  // content hash, so viewers and the edge may keep them for good; the index
  // and manifest are what changes, so those are always revalidated.
  // no-transform keeps the edge from rewriting them: Cloudflare's JavaScript
  // Detections injects a per-request script into HTML, so a plugin's index
  // would hash differently on every load and viewers would reject the
  // presenter's copy as "changed since".
  const pluginDir = path.join(clientDist, "plugins") + path.sep;
  const assetsDir = path.join(clientDist, "assets") + path.sep;
  app.use(
    express.static(clientDist, {
      index: false,
      setHeaders: (res, filePath) => {
        // The plugin API's types (/sdk/v1/presio.d.ts), which mime lookup
        // would call MPEG video.
        if (filePath.endsWith(".d.ts")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
        // Vite's build output: every file under assets/ is named by content
        // hash, so a deploy never changes one in place. Left at express's
        // max-age=0, Cloudflare caps it at its 4h browser TTL instead.
        if (filePath.startsWith(assetsDir)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          return;
        }
        if (!filePath.startsWith(pluginDir)) return;
        res.setHeader(
          "Cache-Control",
          /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(filePath)
            ? "public, max-age=31536000, immutable, no-transform"
            : "no-cache, no-transform"
        );
      },
    })
  );

  // A missing build asset is a stale client asking for an old hash. index.html
  // with a 200 would make the browser fail it as a module parse error instead
  // of a plain 404.
  app.use("/assets", (_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });

  // Pages with a markdown mirror advertise it via rel="alternate".
  const MD_MIRRORS: Record<string, string> = {
    "/": "/index.md",
    "/check": "/check.md",
  };

  // Serve the SPA shell with a per-request canonical URL and og:url so every
  // route carries correct metadata without the client rendering it.
  let indexHtml: string | undefined;
  app.get("*path", (req, res, next) => {
    try {
      indexHtml ??= fs.readFileSync(path.join(clientDist, "index.html"), "utf8");
    } catch (err) {
      return next(err);
    }
    // A markdown path reaching the SPA catch-all means the mirror doesn't
    // exist; the HTML shell with a 200 would read as a broken mirror.
    if (req.path.endsWith(".md")) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const base = canonicalBaseUrl(req);
    const url = `${base}${req.path === "/" ? "/" : req.path}`.replace(
      /[<>"&]/g,
      (c) => ({ "<": "%3C", ">": "%3E", '"': "%22", "&": "&amp;" })[c] as string
    );
    let tags = `<link rel="canonical" href="${url}" />\n  <meta property="og:url" content="${url}" />`;
    // Which origin serves the app and which the audience (lib/origins.ts on
    // the client). Viewer pages are the audience's, not content to index.
    const origins = originPair(req);
    const attr = (v: string) => v.replace(/[<>"&]/g, "");
    tags += `\n  <meta name="presio-app-origin" content="${attr(origins.app)}" />`;
    if (origins.viewer) tags += `\n  <meta name="presio-viewer-origin" content="${attr(origins.viewer)}" />`;
    if (origins.onViewer) res.setHeader("X-Robots-Tag", "noindex");
    const mirror = MD_MIRRORS[req.path];
    if (mirror) tags += `\n  <link rel="alternate" type="text/markdown" href="${base}${mirror}" />`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(indexHtml.replace("</head>", `${tags}\n</head>`));
  });

  // Report unhandled route errors to Sentry. No-op when Sentry isn't
  // initialized (no DSN), and must come after all routes.
  Sentry.setupExpressErrorHandler(app);

  // Anything a route throws (Express 5 forwards async rejections here) ends as
  // JSON, never Express's default HTML page: every caller of these paths is a
  // client that parses the body. Routes answer the errors they expect
  // themselves; this is for the ones they don't.
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(`${req.method} ${req.path} failed:`, err);
    // Too late for a status: let Express close the connection.
    if (res.headersSent) return next(err);
    if (req.path === "/mcp") {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
