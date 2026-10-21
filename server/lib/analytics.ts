// Server-side events for uploads that never pass through the client's tracker
// — POST /api/present and the MCP present_pdf tool, called by agents and
// scripts rather than a browser. Sent to Umami's collection endpoint at
// ANALYTICS_URL (the same instance the client's script.js reports to); unset,
// as in dev, tests and most self-hosted installs, this does nothing.
//
// Fire-and-forget: never awaited, never throws, so analytics can't slow down
// or fail an upload.

import type express from "express";

const WEBSITE_ID = process.env.ANALYTICS_WEBSITE_ID || "3b9c85c6-1dae-4a30-9508-200f274cb857";

// Umami drops hits whose User-Agent looks like a bot, which every agent's
// HTTP client (curl, node, python-requests) does. The caller's own agent goes
// in the event data instead, and this stands in for it on the request.
const USER_AGENT = "Mozilla/5.0 (compatible; Presio)"; // passes isbot, which Umami uses

export function trackServer(req: express.Request, name: string, data: Record<string, unknown>): void {
  const base = process.env.ANALYTICS_URL;
  if (!base) return;
  const body = {
    type: "event",
    payload: {
      website: WEBSITE_ID,
      hostname: req.hostname,
      url: req.path,
      name,
      // The caller's address, so agent uploads aren't all one visitor (the server's).
      ip: req.ip,
      data: { ...data, ua: req.get("user-agent")?.slice(0, 80) },
    },
  };
  fetch(new URL("/api/send", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    // A lost event is never worth surfacing to an uploader.
  });
}
