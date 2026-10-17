// The wire protocol between a plugin's frame (client/public/plugin-frame.html,
// which installs `window.presio`) and the app that hosts it
// (client/src/lib/plugins/host/). Everything after boot travels over one
// MessagePort as envelopes, in both directions:
//
//   { v: 1, kind: "call",   id, method, params }   ask the other side to do something
//   { v: 1, kind: "result", id, method, result }   ...and its answer
//   { v: 1, kind: "error",  id, method, error }    ...or why it couldn't ({ code, message })
//   { v: 1, kind: "event",      method, params }   a notification; nothing comes back
//
// Methods are namespaced ("deck.read", "ui.setButton", "commands.execute").
// The frame calls the host for everything a plugin does; the host sends events
// for what changes (the slide, settings) and calls the frame for what only
// the plugin can answer (run a command, transform a download).
//
// Boot is a handshake: the host posts a window message carrying the port and
// a BootMessage, so the plugin knows the protocol and the host's capabilities
// before its first line runs (presio.supports()).

/** The envelope format's version: `v` on every message. */
export const PROTOCOL_VERSION = 1;

/** The plugin API's major version, which a manifest declares as "presio".
 *  Additive changes keep it; a breaking change is a new major, run by a
 *  runtime of its own, chosen per frame. */
export const API_VERSION = 1;

export type EnvelopeKind = "call" | "result" | "error" | "event";

export interface CallEnvelope {
  v: typeof PROTOCOL_VERSION;
  kind: "call";
  id: number;
  method: string;
  params?: unknown;
}

export interface ResultEnvelope {
  v: typeof PROTOCOL_VERSION;
  kind: "result";
  id: number;
  method: string;
  result?: unknown;
}

export interface ErrorEnvelope {
  v: typeof PROTOCOL_VERSION;
  kind: "error";
  id: number;
  method: string;
  error: { code: ErrorCode; message: string };
}

export interface EventEnvelope {
  v: typeof PROTOCOL_VERSION;
  kind: "event";
  method: string;
  params?: unknown;
}

export type Envelope = CallEnvelope | ResultEnvelope | ErrorEnvelope | EventEnvelope;

/** Why a call failed. A plugin can branch on these; the message is for people. */
export const ERROR_CODES = [
  /** No such method (a typo, or a newer API than this host has). */
  "MethodNotFound",
  /** The manifest doesn't ask for the permission the method needs. */
  "PermissionDenied",
  /** The params don't fit the method. */
  "InvalidParams",
  /** Not here, not now: a capability this host lacks, a role that can't
   *  (a viewer saving the deck), or a target that isn't running. */
  "Unavailable",
  /** It went wrong on the other side. */
  "Internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * What a host can do, by feature: what presio.supports() answers. A plugin
 * that uses something newer checks first and degrades. Hosts advertise only
 * what they implement; the rest of this list is reserved for what's coming.
 */
export const CAPABILITIES = [
  "slide",
  "context",
  "settings",
  "storage",
  "messages",
  "commands",
  "deck",
  "layers",
  "history",
  "blobs",
  "clock",
  "ui",
  "panels",
  "audience",
  // Reserved: designed, not yet implemented by any host.
  "status",
  "viewerSheet",
  "palette",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** What the host posts to boot a frame (as a window message, with the port). */
export interface BootMessage<Context = unknown> {
  type: "presio:boot";
  protocol: typeof PROTOCOL_VERSION;
  capabilities: Capability[];
  context: Context;
  /** The plugin's HTML, written into the frame once `presio` is installed. */
  html: string;
}

// --- The method catalogue ---
//
// Names only; each side validates params itself. Kept here so the host's
// dispatch table, the frame runtime and the SDK types agree on spelling.

/** Calls a frame makes to the host. */
export type HostMethod =
  | "messages.send"
  | "storage.set"
  | "settings.set"
  | "commands.register"
  | "commands.unregister"
  | "commands.execute"
  | "deck.attachments"
  | "deck.bytes"
  | "deck.pages"
  | "deck.save"
  | "deck.setExporter"
  | "layers.set"
  | "layers.clear"
  | "history.open"
  | "history.commit"
  | "blobs.put"
  | "blobs.get"
  | "ui.setVisible"
  | "ui.setInteractive"
  | "ui.setButton"
  | "audience.set"
  | "audience.open"
  | "audience.close"
  | "audience.clear"
  | "audience.all"
  | "audience.summary";

/** Calls the host makes to a frame. */
export type FrameMethod =
  /** { command, args } → whatever the plugin's handler returns. */
  | "commands.run"
  /** { bytes, mode } → the transformed PDF (presio.deck.onExport). */
  | "deck.export"
  /** {} → { seq, data }: a snapshot of the plugin's ordered history state. */
  | "history.snapshot";

/** Events the host sends a frame. */
export type FrameEvent =
  | "context.change"
  | "slide.change"
  | "settings.change"
  | "storage.change"
  | "commands.shortcuts"
  | "clock.offset"
  | "deck.change"
  | "ui.view"
  | "ui.page"
  | "ui.hover"
  | "messages.receive"
  | "history.update"
  /** { key, open }: a key opened or closed (every role). */
  | "audience.state"
  /** { key, value }: this viewer's own value changed (cleared, or set from another frame). */
  | "audience.mine"
  /** { key, summary, changes, reset? }: viewers' values changed (presenter). */
  | "audience.change";

/** Events a frame sends the host. */
export type HostEvent =
  /** The plugin's document is in place. */
  "frame.ready";

/** An envelope's shape, checked loosely: what arrives on a port is untrusted. */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return m.v === PROTOCOL_VERSION && typeof m.kind === "string" && typeof m.method === "string";
}

/** A call's result or error as an envelope, for the side answering it. */
export function resultOf(call: CallEnvelope, result: unknown): ResultEnvelope {
  return { v: PROTOCOL_VERSION, kind: "result", id: call.id, method: call.method, result };
}

export function errorOf(call: CallEnvelope, code: ErrorCode, message: string): ErrorEnvelope {
  return { v: PROTOCOL_VERSION, kind: "error", id: call.id, method: call.method, error: { code, message } };
}

export function eventOf(method: string, params?: unknown): EventEnvelope {
  return { v: PROTOCOL_VERSION, kind: "event", method, params };
}

// --- Shared limits ---

/** One plugin message's payload, as JSON (the server enforces it too). */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** A message type: what presio.messages.send's first argument may be. */
export const MESSAGE_TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
