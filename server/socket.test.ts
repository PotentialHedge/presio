import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "http";
import { Server } from "socket.io";
import { io as ioClient, type Socket } from "socket.io-client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerSocketHandlers, createSocketState } from "./socket/index.js";
import { FakeSupabase } from "./test/fakeSupabase.js";

let server: http.Server;
let io: Server;
let fake: FakeSupabase;
let url: string;
const clients: Socket[] = [];

const SESSION = {
  id: "SESS01",
  controller_token: "ctrl-tok",
  total_slides: 12,
  current_slide: 1,
  note_prefix: "note:",
};

beforeAll(async () => {
  server = http.createServer();
  io = new Server(server);
  fake = new FakeSupabase([SESSION]);
  // The handlers read `fake.rows` live, so reseeding in beforeEach is reflected.
  registerSocketHandlers(io, fake as unknown as SupabaseClient, createSocketState());
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  if (addr && typeof addr === "object") url = `http://localhost:${addr.port}`;
});

afterAll(() => {
  io.close();
  server.close();
});

beforeEach(() => {
  // Reset session state between tests.
  fake.rows = [{ ...SESSION }];
});

afterEach(() => {
  while (clients.length) clients.pop()?.disconnect();
});

function connect(): Socket {
  const s = ioClient(url, { transports: ["websocket"], forceNew: true });
  clients.push(s);
  return s;
}

function once<T = unknown>(s: Socket, event: string): Promise<T> {
  return new Promise((resolve) => s.once(event, resolve));
}

// Join and resolve with the granted session_state.
function join(s: Socket, role: string, token?: string): Promise<{ role: string }> {
  const p = once<{ role: string }>(s, "session_state");
  s.emit("join_session", { sessionId: SESSION.id, role, token });
  return p;
}

// Resolve true if `event` does NOT fire within `ms` (i.e. the action was ignored).
function notReceived(s: Socket, event: string, ms = 150): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    s.once(event, () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

describe("join_session", () => {
  it("grants the controller role only with the correct token", async () => {
    const c = connect();
    const state = await join(c, "controller", "ctrl-tok");
    expect(state.role).toBe("controller");
  });

  it("downgrades a controller with a bad token to viewer", async () => {
    const c = connect();
    const state = await join(c, "controller", "wrong");
    expect(state.role).toBe("viewer");
  });
});

describe("slide_change authorization", () => {
  it("broadcasts a controller's valid slide change to viewers", async () => {
    const ctrl = connect();
    const viewer = connect();
    await join(ctrl, "controller", "ctrl-tok");
    await join(viewer, "viewer");

    const got = once<{ slideNumber: number }>(viewer, "slide_update");
    ctrl.emit("slide_change", { slideNumber: 5 });
    expect((await got).slideNumber).toBe(5);
  });

  it("ignores slide changes from a non-controller", async () => {
    const ctrl = connect();
    const viewer = connect();
    await join(ctrl, "controller", "ctrl-tok");
    await join(viewer, "viewer");

    const ignored = notReceived(ctrl, "slide_update");
    viewer.emit("slide_change", { slideNumber: 7 });
    expect(await ignored).toBe(true);
  });

  it("ignores out-of-range slide numbers", async () => {
    const ctrl = connect();
    await join(ctrl, "controller", "ctrl-tok");

    const ignored = notReceived(ctrl, "slide_update");
    ctrl.emit("slide_change", { slideNumber: 999 }); // > total_slides (12)
    expect(await ignored).toBe(true);
  });
});
