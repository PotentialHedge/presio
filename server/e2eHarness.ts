// Standalone harness for the Playwright E2E suite. Lives under server/ so Node
// resolves express/socket.io from server/node_modules. Boots the real Express
// app (createApp) and socket handlers wired to an in-memory FakeSupabase, serves
// the built client from client/dist, and serves the example PDF so the viewer
// can actually render slides. No real Supabase project required.
import http from "http";
import path from "path";
import express from "express";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "./app.js";
import { registerSocketHandlers, createSocketState } from "./socket/index.js";
import { FakeSupabase } from "./test/fakeSupabase.js";
import { PORT, SESSION_ID, CONTROLLER_TOKEN, TOTAL_SLIDES } from "../e2e/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || PORT);

// The specs use example/example.pdf and its 7 pages. scripts/record-demo.mts
// points these at its own deck instead, so the homepage recording isn't driven
// by the media test fixture.
const deckPath = process.env.E2E_PDF
  ? path.resolve(process.env.E2E_PDF)
  : path.resolve(__dirname, "../example/example.pdf");
const totalSlides = Number(process.env.E2E_TOTAL_SLIDES || TOTAL_SLIDES);
const filename = process.env.E2E_FILENAME || "E2E Deck";

// Allow the harness's own origin so the browser's API/socket requests (which
// carry an Origin header) aren't rejected by the CORS guard. In production the
// client and server share an origin and this isn't needed.
process.env.ALLOWED_ORIGIN = `http://localhost:${port}`;

// One session shape, minted under different ids. SESSION_ID is the fixed one
// scripts/record-demo.mts drives; the specs mint their own (see below).
// The link spec needs a deck that actually carries link annotations, which the
// example deck does not. It is a second file rather than links bolted onto the
// example, so the demo recording and the other specs keep the deck they were
// written against.
const linkDeckPath = path.resolve(__dirname, "../e2e/fixtures/links.pdf");
const LINK_DECK_SLIDES = 2;

const sessionRow = (id: string, deck: "example" | "links" = "example") => ({
  id,
  pdf_path: "",
  pdf_url: deck === "links" ? "/links.pdf" : "/test.pdf",
  filename,
  total_slides: deck === "links" ? LINK_DECK_SLIDES : totalSlides,
  current_slide: 1,
  note_prefix: "note:",
  local: false,
  controller_token: CONTROLLER_TOKEN,
  passphrase: "E2EPASS1",
  user_id: null,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
});

const fake = new FakeSupabase([sessionRow(SESSION_ID)]);

const io = new Server();
const socketState = createSocketState();
const inner = createApp({ supabase: fake as unknown as SupabaseClient, io, socketState });

// Wrap createApp so the example PDF route is matched before its catch-all.
const app = express();
app.get("/test.pdf", (_req, res) => {
  res.sendFile(deckPath);
});
app.get("/links.pdf", (_req, res) => {
  res.sendFile(linkDeckPath);
});

// Test-only: mint an isolated session.
//
// Playwright runs `fullyParallel`, and a session carries mutable state the
// specs care about — current slide, drawings, timer. Sharing one id across
// concurrent tests made them fail only when run together (a second controller
// joining mid-test), which is the worst kind of flake. Each spec takes a fresh
// id instead, so nothing carries between tests or across workers.
let minted = 0;
app.post("/__e2e/session", (req, res) => {
  const id = `E2E${String(minted++).padStart(3, "0")}`;
  const deck = req.query.deck === "links" ? "links" : "example";
  fake.seed(sessionRow(id, deck));
  res.json({ id, controllerToken: CONTROLLER_TOKEN });
});

app.use(inner);

const server = http.createServer(app);
io.attach(server);
registerSocketHandlers(io, fake as unknown as SupabaseClient, socketState);

server.listen(port, () => {
  console.log(`E2E harness on http://localhost:${port}`);
});
