import { PLUGIN_ID_RE } from "../shared/plugin/sources.js";
import { MAX_MESSAGE_BYTES, MESSAGE_TYPE_RE, VIEWER_ADDRESS_RE } from "../shared/plugin/protocol.js";

// Pure validation/sanitization helpers, factored out of the request/socket
// handlers so they can be unit-tested without a server or Supabase.

// Validate a user-supplied external PDF URL. This is a syntactic check only —
// scheme and shape — and deliberately says nothing about where the URL points.
//
// The value is mainly handed back to the client to fetch. It is also probed by
// the server for change detection (GET /api/sessions/:id/remote-version), and
// that path must NOT rely on this function for safety: dereferencing a
// visitor-supplied URL needs address-level checks, which live in
// lib/remotePdf.ts (isSafeRemoteUrl). Anything new that fetches a pdf_url
// server-side belongs behind that helper too.
export function isValidHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Light-touch email validation for the newsletter list: something@something.tld
// with sane length. Deliverability is not our problem here.
export function isValidEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
  );
}

// Upper bound on a deck's declared page count. total_slides is client-supplied
// at session creation and bounds slide numbers, so it must be bounded; no real
// presentation comes close.
export const MAX_TOTAL_SLIDES = 3000;

// Largest PDF the server accepts on an upload. The client mirrors this in
// client/src/lib/limits.ts to disable Sync before an upload that would fail.
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

export function isValidTotalSlides(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_TOTAL_SLIDES;
}

// A slide number is valid when it's a positive integer within the deck. When
// `total` is unknown (non-number) only the lower bound is enforced.
export function isValidSlideNumber(slideNumber: unknown, total: unknown): boolean {
  if (!Number.isInteger(slideNumber) || (slideNumber as number) < 1) return false;
  if (typeof total === "number" && (slideNumber as number) > total) return false;
  return true;
}

// --- Plugins ---
//
// The server never runs plugin code or looks inside plugin messages: it relays
// them between the presenter and the audience, keeps the presenter's "retained"
// messages for late joiners, and tells viewers which plugins the presenter
// published (where to load them — never the plugins themselves). These caps
// bound what a controller or viewer can make it hold.

// Plugin ids are derived from where a plugin is loaded from ("presio/timer",
// "alice/poll", "url:localhost:5174/demo"; see shared/plugin/sources.ts).
export { PLUGIN_ID_RE };
const PLUGIN_TYPE_RE = MESSAGE_TYPE_RE;
// A plugin page's SHA-256, hex.
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_PLUGIN_PAYLOAD_BYTES = MAX_MESSAGE_BYTES;
export const MAX_PLUGINS_PER_SESSION = 8;
// Retained messages are a plugin's state for late joiners, one message per
// piece of it — a drawing keeps each slide's strokes in a few. So a plugin may
// keep many, and the byte budget is what bounds memory: 2 MB per plugin (a
// few hundred thousand compactly encoded points), 16 MB for a session with
// every plugin slot full.
export const MAX_RETAINED_PER_PLUGIN = 1024;
export const MAX_RETAINED_BYTES_PER_PLUGIN = 2 * 1024 * 1024;

/** true: kept for the session; "deck": kept until the deck is replaced. */
export type Retain = boolean | "deck";

export interface PluginEvent {
  plugin: string;
  type: string;
  payload: unknown;
  retain: Retain;
  /** May be dropped for a backed-up viewer rather than queued. */
  volatile: boolean;
  /** Presenter: for this one viewer only (its socket id); never retained. */
  to?: string;
}

interface PluginManifest {
  name: string;
  displayName?: string;
  version: string;
  author?: string;
  description?: string;
  surfaces: string[];
  permissions: string[];
}

/** A plugin the presenter runs on viewers: its id, where they load it from,
 *  and the hash of its HTML, which viewers check what they load against. The
 *  server never carries the plugin itself. */
export interface PublishedPlugin {
  id: string;
  manifest: PluginManifest;
  url: string;
  hash: string;
}

// Size of a value once serialized, or Infinity when it can't be (cycles are
// impossible off the wire, but BigInt-like oddities aren't worth reasoning about).
export function jsonSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Infinity;
  }
}

/** An untrusted payload's fields ({} when it isn't an object): socket
 *  handlers read what they need and check each value. */
export function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** A plugin message's fields, when it's an object naming a valid plugin id. */
function pluginMessage(raw: unknown): (Record<string, unknown> & { plugin: string }) | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  return typeof e.plugin === "string" && PLUGIN_ID_RE.test(e.plugin) ? (e as Record<string, unknown> & { plugin: string }) : null;
}

export function sanitizePluginEvent(raw: unknown): PluginEvent | null {
  const e = pluginMessage(raw);
  if (!e) return null;
  if (typeof e.type !== "string" || !PLUGIN_TYPE_RE.test(e.type)) return null;
  const payload = e.payload === undefined ? null : e.payload;
  if (jsonSize(payload) > MAX_PLUGIN_PAYLOAD_BYTES) return null;
  if (e.to !== undefined && (typeof e.to !== "string" || !VIEWER_ADDRESS_RE.test(e.to))) return null;
  const to = e.to as string | undefined;
  const retain = !to && (e.retain === true || e.retain === "deck") ? e.retain : false;
  return { plugin: e.plugin, type: e.type, payload, retain, volatile: e.volatile === true, ...(to ? { to } : {}) };
}

// A plugin's resolved settings, as the presenter publishes them for viewers.
export function sanitizePluginSettings(raw: unknown): { plugin: string; settings: Record<string, unknown> } | null {
  const e = pluginMessage(raw);
  if (!e) return null;
  const settings = e.settings;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return null;
  if (jsonSize(settings) > MAX_PLUGIN_PAYLOAD_BYTES) return null;
  return { plugin: e.plugin, settings: settings as Record<string, unknown> };
}

// A viewer couldn't load a plugin the presenter published: which (by id and
// the hash it was published with) and why, in a line for the presenter.
// The plugins a viewer has frames running for (plugin_presence): at most one
// per published plugin.
export function sanitizePluginPresence(raw: unknown): string[] | null {
  const plugins = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).plugins : null;
  if (!Array.isArray(plugins) || plugins.length > MAX_PLUGINS_PER_SESSION) return null;
  if (!plugins.every((p) => typeof p === "string" && PLUGIN_ID_RE.test(p))) return null;
  return [...new Set(plugins as string[])];
}

export function sanitizePluginLoadFailure(raw: unknown): { plugin: string; hash: string; reason: string } | null {
  const e = pluginMessage(raw);
  if (!e) return null;
  if (typeof e.hash !== "string" || !HASH_RE.test(e.hash)) return null;
  const reason = typeof e.reason === "string" ? e.reason.slice(0, 200) : "";
  return { plugin: e.plugin, hash: e.hash, reason };
}

const shortString = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length <= max ? v : undefined;

// A published plugin: the manifest fields viewers need to label and mount it,
// where to load it from and the hash its page must match. Only the controller
// can publish, but it is still client input, so everything is re-checked here.
export function sanitizePublishedPlugin(raw: unknown): PublishedPlugin | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as { id?: unknown; manifest?: Record<string, unknown>; url?: unknown; hash?: unknown };
  const m = b.manifest;
  if (typeof m !== "object" || m === null) return null;
  if (typeof b.id !== "string" || !PLUGIN_ID_RE.test(b.id)) return null;
  const name = shortString(m.name, 80);
  const version = shortString(m.version, 32);
  if (!name || !version) return null;
  const shortList = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length <= 32);
  if (!shortList(m.surfaces)) return null;
  const permissions = m.permissions === undefined ? [] : m.permissions;
  if (!shortList(permissions)) return null;
  // A path on this deployment (built-ins, loaded by each viewer from its own
  // origin) or a web URL — nothing a browser would run as a script.
  const url = typeof b.url === "string" && b.url.length <= 2048 ? b.url : "";
  if (!/^(\/(?!\/)|https?:\/\/)/i.test(url)) return null;
  if (typeof b.hash !== "string" || !HASH_RE.test(b.hash)) return null;
  return {
    id: b.id,
    manifest: {
      name,
      displayName: shortString(m.displayName, 80),
      version,
      author: shortString(m.author, 80),
      description: shortString(m.description, 300),
      surfaces: (m.surfaces as string[]).slice(0, 8),
      permissions: (permissions as string[]).slice(0, 8),
    },
    url,
    hash: b.hash,
  };
}
