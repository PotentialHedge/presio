import type express from "express";
import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { baseUrl, canonicalBaseUrl } from "../lib/baseUrl.js";
import { createPresentHandoff, updatePresentDeck } from "../lib/presentHandoff.js";
import { buildCheckReport } from "./check.js";
import { agentDoc } from "./agentDocs.js";
import { resolveOptionalUserId } from "../auth.js";
import type { SocketState } from "../socket.js";

/** Live-broadcast deps, so an MCP deck replacement reaches viewers exactly as
 *  the REST one does. Without them `updatePresentDeck` silently skips the
 *  `deck_updated` emit and leaves everyone watching a synced deck on the old
 *  slides with stale drawings. */
export interface McpDeps {
  io?: Server;
  socketState?: SocketState;
}

function createPresioMcp(supabase: SupabaseClient, origin: string, req: express.Request, deps: McpDeps) {
  const server = new McpServer({
    name: "presio",
    version: "1.0.0",
  });

  server.registerTool(
    "present_pdf",
    {
      title: "Present a PDF",
      description:
        "Upload a PDF to start a local Presio presentation. Returns a url — open it in a browser to finish handoff (skips share). To replace an existing presentation's deck instead of creating one, pass its session_id plus controller_token (the t= parameter of the url from the original create call) and the same link keeps working. Same as POST /api/present.",
      annotations: {
        readOnlyHint: false,
        // Creating is additive, but the session_id path overwrites an existing
        // deck in place and the old slides are not recoverable.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        pdf_base64: z.string().describe("PDF file contents, base64-encoded"),
        filename: z.string().optional().describe("Original filename, e.g. deck.pdf"),
        session_id: z
          .string()
          .optional()
          .describe("Id of an existing presentation to update in place (from an earlier present response) instead of creating a new one"),
        controller_token: z
          .string()
          .optional()
          .describe("Controller token for that presentation — the t= query parameter of the url returned when it was created. Required whenever session_id is given."),
      },
    },
    async ({ pdf_base64, filename, session_id, controller_token }) => {
      const buffer = Buffer.from(pdf_base64, "base64");
      if (session_id) {
        if (!controller_token) {
          return {
            content: [
              { type: "text" as const, text: "controller_token is required when updating an existing presentation (session_id)." },
            ],
            isError: true,
          };
        }
        const result = await updatePresentDeck(supabase, {
          sessionId: session_id,
          token: controller_token,
          buffer,
          originalName: filename || "",
          baseUrl: origin,
          io: deps.io,
          socketState: deps.socketState,
        });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: result.error }], isError: true };
        }
        // Same whitelist as the create branch below — `ok` is internal.
        const updatedPayload = {
          id: result.id,
          url: result.url,
          filename: result.filename,
          totalSlides: result.totalSlides,
          next: result.next,
          updated: true,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(updatedPayload, null, 2) }] };
      }
      const userId = await resolveOptionalUserId(supabase, req);
      const result = await createPresentHandoff(supabase, {
        buffer,
        originalName: filename || "presentation.pdf",
        userId,
        baseUrl: origin,
      });
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: result.error }], isError: true };
      }
      const payload = {
        id: result.id,
        url: result.url,
        filename: result.filename,
        totalSlides: result.totalSlides,
        next: result.next,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    }
  );

  server.registerTool(
    "check_pdf",
    {
      title: "Check PDF sidecars",
      description:
        "Validate Presio notes/media sidecar attachments in a PDF. Same as POST /api/check.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        pdf_base64: z.string().describe("PDF file contents, base64-encoded"),
      },
    },
    async ({ pdf_base64 }) => {
      const buffer = Buffer.from(pdf_base64, "base64");
      const result = await buildCheckReport(buffer, origin);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: result.error }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result.report, null, 2) }] };
    }
  );

  server.registerTool(
    "plugin_guide",
    {
      title: "How to build a Presio plugin",
      description:
        "The guide to building a Presio plugin: the workflow (a presio-<name> GitHub repo from the template, the checker, a tag, and a ?plugins= link that loads it), the manifest, and the full window.presio API. Read it before writing a plugin. Same as GET /plugins.md.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text" as const, text: agentDoc("plugins.md", origin) }] })
  );

  return server;
}

export function registerMcpRoutes(app: express.Express, supabase: SupabaseClient, deps: McpDeps = {}) {
  app.get("/.well-known/mcp.json", (req, res) => {
    // Discovery metadata describes the server itself, so it names one origin
    // regardless of which domain the scanner happened to ask.
    const origin = canonicalBaseUrl(req);
    res.setHeader("Cache-Control", "public, max-age=300");
    // Public discovery metadata — readable from any origin, unlike the API.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
      // Top-level name/description/version/endpoint duplicated for scanners
      // that expect a flat server card rather than the nested shape.
      name: "presio",
      version: "1.0.0",
      description: "Start local PDF presentations, validate Presio sidecars, and learn to build Presio plugins",
      endpoint: `${origin}/mcp`,
      protocolVersion: "2025-11-25",
      serverInfo: {
        name: "presio",
        version: "1.0.0",
        description: "Start local PDF presentations, validate Presio sidecars, and learn to build Presio plugins",
      },
      transport: { type: "streamable-http", endpoint: `${origin}/mcp` },
      capabilities: { tools: true },
      authentication: { required: false },
    });
  });

  app.post("/mcp", async (req, res) => {
    // Request-following: the handoff URL a tool hands back must be one the
    // caller can actually open, on the domain they reached us on.
    const origin = baseUrl(req);
    const server = createPresioMcp(supabase, origin, req, deps);
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (err) {
      console.error("MCP error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST for streamable HTTP." },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });
}
