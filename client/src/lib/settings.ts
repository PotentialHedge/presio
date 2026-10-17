// User settings: one JSON document, in the spirit of VS Code's settings.json.
//
// Keys are dotted ("share.lanAddress"), and the document holds only what differs
// from the defaults, so an exported file reads as "what this presenter
// changed". Presio's own settings are declared in CORE_SETTINGS below; plugins
// contribute theirs through their manifest, namespaced by plugin id
// ("presio/join-code.showUrl"). Values are validated on the way out, never trusted on
// the way in: an imported or hand-edited document can hold anything, and a bad
// value reads back as the default rather than breaking the app.
//
// Settings are preferences. Things the app merely remembers — the dashboard
// layout, dismissed prompts, anything per deck or per session — are state and
// stay in their own keys (lib/storage.ts), as VS Code keeps them out of
// settings.json too.

import { useCallback, useSyncExternalStore } from "react";
import { lsGet, lsSet, STORAGE_KEYS } from "./storage";
import { DEFAULT_KEYMAP, KEYMAP_ACTIONS, type KeyBinding, type Keymap } from "./keymap";

// --- Schema ---

// How a setting is declared and checked; plugins declare theirs the same way.
import { sanitizeSettingValue, type SettingSpec } from "@shared/plugin/settings";
import { PLUGIN_ID_RE, qualify, splitQualified } from "@shared/plugin/sources";
export { sanitizeSettingValue, type SettingSpec };

type CoreSpec<T> = SettingSpec & {
  default: T;
  /** Deeper validation for object values; the result is what reads return. */
  sanitize?: (raw: unknown) => T | undefined;
};

export type ThemeSetting = "system" | "light" | "dark";

export interface CoreSettings {
  theme: ThemeSetting;
  keybindings: Keymap;
  "share.lanAddress": string;
  "home.minimal": boolean;
  "layout.forceDesktop": boolean;
  /** By source without its version (shared/plugin/sources.ts): whether it's
   *  on, where it loads from, the id it has and the version it's on (a tag,
   *  a branch or a commit). Built-ins appear only once toggled. */
  plugins: Record<string, { enabled: boolean; url?: string; id?: string; ref?: string }>;
}

export type CoreSettingKey = keyof CoreSettings;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** "<plugin id>.<command>": a plugin command's bindings. */
const isPluginCommandKey = (key: string) => {
  const parts = splitQualified(key);
  return !!parts && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(parts.name);
};

function sanitizeKeymap(raw: unknown): Keymap | undefined {
  if (!isRecord(raw)) return undefined;
  const isBinding = (b: unknown): b is KeyBinding =>
    isRecord(b) && typeof b.key === "string" && b.key.length > 0 && (b.meta === undefined || typeof b.meta === "boolean");
  // Merged over the defaults, so a map saved before an action existed still
  // binds it.
  const km: Keymap = { ...DEFAULT_KEYMAP };
  const clean = (list: KeyBinding[]) => list.map((b) => (b.meta ? { key: b.key, meta: true } : { key: b.key }));
  for (const action of KEYMAP_ACTIONS) {
    const list = raw[action];
    if (Array.isArray(list) && list.every(isBinding)) km[action] = clean(list);
  }
  // Plugins' commands, kept whether or not the plugin is installed here (like
  // their settings), so an imported file doesn't lose them.
  for (const [key, list] of Object.entries(raw)) {
    if (isPluginCommandKey(key) && Array.isArray(list) && list.length <= 3 && list.every(isBinding)) km[key] = clean(list);
  }
  return km;
}

function sanitizePluginList(raw: unknown): CoreSettings["plugins"] | undefined {
  if (!isRecord(raw)) return undefined;
  const out: CoreSettings["plugins"] = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!isRecord(entry) || typeof entry.enabled !== "boolean" || key.length > 2048) continue;
    const url = typeof entry.url === "string" && /^(\/plugins\/|https?:\/\/)/.test(entry.url) ? entry.url : undefined;
    const id = typeof entry.id === "string" && PLUGIN_ID_RE.test(entry.id) ? entry.id : undefined;
    const ref = typeof entry.ref === "string" && /^[^\s/]{1,200}$/.test(entry.ref) ? entry.ref : undefined;
    out[key] = { enabled: entry.enabled, ...(url && { url }), ...(id && { id }), ...(ref && { ref }) };
  }
  return out;
}

export const CORE_SETTINGS: { [K in CoreSettingKey]: CoreSpec<CoreSettings[K]> } = {
  theme: {
    type: "enum",
    values: ["system", "light", "dark"],
    default: "system",
    description: "Color theme. \"system\" follows the operating system.",
  },
  keybindings: {
    type: "object",
    default: DEFAULT_KEYMAP,
    sanitize: sanitizeKeymap,
    description: "Controller keyboard shortcuts, per action (or \"<plugin id>.<command>\" for a plugin's): a list of { key, meta? }.",
  },
  "share.lanAddress": {
    type: "string",
    default: "",
    maxLength: 253,
    description: "This machine's address on the local network, used in share links when Presio is opened over localhost.",
  },
  "home.minimal": {
    type: "boolean",
    default: false,
    description: "Strip the landing page down to the drop zone.",
  },
  "layout.forceDesktop": {
    type: "boolean",
    default: false,
    description: "Use the desktop layout on phones and tablets too (also set by ?desktop=1).",
  },
  plugins: {
    type: "object",
    default: {},
    sanitize: sanitizePluginList,
    description: "Plugins by source (\"presio/timer\", \"github:owner/repo\", a URL): { enabled, url, id, ref }, ref being the tag, branch or commit it's on.",
  },
};

// --- Store ---

type Doc = Record<string, unknown>;

const listeners = new Set<() => void>();
// Loaded on first use rather than at import, so migration runs only once
// something actually reads a setting.
let loaded: Doc | null = null;
const current = (): Doc => (loaded ??= loadDoc());
// Resolved values by key, cleared whenever the document changes, so reads
// hand back a stable identity for useSyncExternalStore.
const resolved = new Map<string, unknown>();

function loadDoc(): Doc {
  const stored = lsGet<unknown>(STORAGE_KEYS.settings, undefined);
  if (isRecord(stored)) return stored;
  const migrated = migrateLegacySettings();
  lsSet(STORAGE_KEYS.settings, migrated);
  return migrated;
}

function commit(next: Doc) {
  loaded = next;
  resolved.clear();
  lsSet(STORAGE_KEYS.settings, next);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Another window changed the document (the viewer popup, a second tab).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEYS.settings) return;
    const stored = lsGet<unknown>(STORAGE_KEYS.settings, {});
    loaded = isRecord(stored) ? stored : {};
    resolved.clear();
    listeners.forEach((l) => l());
  });
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function getSetting<K extends CoreSettingKey>(key: K): CoreSettings[K] {
  if (resolved.has(key)) return resolved.get(key) as CoreSettings[K];
  const spec = CORE_SETTINGS[key] as CoreSpec<CoreSettings[K]>;
  const raw = current()[key];
  let value: CoreSettings[K] | undefined;
  if (raw !== undefined) {
    value = spec.sanitize
      ? spec.sanitize(raw)
      : (sanitizeSettingValue(spec, raw) as CoreSettings[K] | undefined);
  }
  const out = value ?? spec.default;
  resolved.set(key, out);
  return out;
}

export function setSetting<K extends CoreSettingKey>(key: K, value: CoreSettings[K]) {
  setRawSetting(key, sameValue(value, CORE_SETTINGS[key].default) ? undefined : value);
}

/** Write any key as-is (undefined removes it). For plugin settings, whose
 *  specs the store doesn't know; callers validate. */
export function setRawSetting(key: string, value: unknown) {
  const next = { ...current() };
  if (value === undefined) delete next[key];
  else next[key] = value;
  commit(next);
}

export function useSetting<K extends CoreSettingKey>(key: K): [CoreSettings[K], (value: CoreSettings[K]) => void] {
  const value = useSyncExternalStore(subscribe, () => getSetting(key));
  const set = useCallback((next: CoreSettings[K]) => setSetting(key, next), [key]);
  return [value, set];
}

/** The raw document: what's stored, defaults omitted. */
export function useSettingsDocument(): Doc {
  return useSyncExternalStore(subscribe, current);
}

/**
 * A plugin's settings, resolved against the specs it contributes: every
 * declared name, with the stored value where it's valid and the default
 * otherwise. Keys in the document are `<pluginId>.<name>`.
 */
export function resolvePluginSettings(
  pluginId: string,
  specs: Record<string, SettingSpec>,
  source: Doc = current()
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const raw = source[qualify(pluginId, name)];
    const value = raw === undefined ? undefined : sanitizeSettingValue(spec, raw);
    out[name] = value === undefined ? spec.default : value;
  }
  return out;
}

export function setPluginSetting(pluginId: string, name: string, spec: SettingSpec, value: unknown) {
  const key = qualify(pluginId, name);
  if (sameValue(value, spec.default)) setRawSetting(key, undefined);
  else if (sanitizeSettingValue(spec, value) !== undefined) setRawSetting(key, value);
}

/** The document as a settings.json file. */
export function exportSettings(): string {
  return `${JSON.stringify(current(), null, 2)}\n`;
}

/**
 * Replace the document with an imported settings.json. Only the shape is
 * checked here (an object of keys): values are validated when read, and keys
 * this build doesn't know — a plugin not installed here yet — are kept.
 */
export function importSettings(text: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (!isRecord(parsed)) throw new Error("A settings file is a JSON object of settings.");
  commit(parsed);
}

// --- Migration ---

/**
 * Build the first document from the keys each setting used to live under,
 * then drop them. Runs once per browser: after this the document exists.
 * Values go through the same validation as any read, so a corrupt legacy value
 * is simply left behind.
 */
function migrateLegacySettings(): Doc {
  const out: Doc = {};
  const read = (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const json = (key: string): unknown => {
    const raw = read(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const put = <K extends CoreSettingKey>(key: K, raw: unknown) => {
    if (raw === undefined || (raw === null && CORE_SETTINGS[key].default !== null)) return;
    const spec = CORE_SETTINGS[key] as CoreSpec<CoreSettings[K]>;
    const value = spec.sanitize ? spec.sanitize(raw) : sanitizeSettingValue(spec, raw);
    if (value !== undefined && !sameValue(value, spec.default)) out[key] = value;
  };

  put("theme", read("theme") ?? undefined);
  put("keybindings", json("presio_keymap"));
  // The timer is a built-in plugin now; its settings are the plugin's, in
  // minutes where they used to be seconds. Read back through the manifest's
  // specs, so anything off is dropped there.
  const timer = json("presio_timer_settings");
  if (isRecord(timer)) {
    if (timer.mode === "down") out["presio/timer.mode"] = "down";
    for (const [from, to] of [["duration", "presio/timer.durationMinutes"], ["threshold", "presio/timer.warningMinutes"]]) {
      const seconds = timer[from];
      if (typeof seconds === "number" && seconds > 0) out[to] = seconds / 60;
    }
  }
  if (read("presio_timer_show_clock") === "true") out["presio/timer.showClock"] = true;
  // Likewise the notes plugin's text size.
  const notesScale = json("presio_notes_font_scale");
  if (typeof notesScale === "number" && notesScale !== 1) out["presio/notes.fontScale"] = notesScale;
  // And drawing's: the palette's visibility, and each tool's color and width.
  if (read("presio_annotation_toolbar") === "false") out["presio/drawing.toolbar"] = false;
  Object.assign(out, drawingStyle("pen", json("presio_pen_style")), drawingStyle("highlighter", json("presio_highlighter_style")));
  put("share.lanAddress", read("presio_lan_address") ?? undefined);
  put("home.minimal", json("presio_home_minimal"));
  if (read("presio_force_desktop") !== null) put("layout.forceDesktop", read("presio_force_desktop") === "true");

  for (const key of LEGACY_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch { /* storage unavailable */ }
  }
  return out;
}

/**
 * A drawing tool's style as it used to be stored ({ color, size }, the size a
 * fraction of the slide width) as the drawing plugin's settings: a color and
 * a width in pixels at a 960px-wide slide. Values the plugin wouldn't accept
 * are dropped there, when read.
 */
function drawingStyle(tool: "pen" | "highlighter", raw: unknown): Doc {
  const out: Doc = {};
  if (!isRecord(raw)) return out;
  // The plugin's defaults (client/plugins/drawing/presio-plugin.json), which
  // the document leaves out.
  const defaults = tool === "pen" ? { color: "#e11d48", size: 3 } : { color: "#facc15", size: 14 };
  const color = typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color.toLowerCase() : null;
  if (color && color !== defaults.color) out[`presio/drawing.${tool}Color`] = color;
  const size = typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size > 0 ? Math.round(raw.size * 960 * 10) / 10 : null;
  if (size !== null && size !== defaults.size) out[`presio/drawing.${tool}Size`] = size;
  return out;
}

const LEGACY_KEYS = [
  "theme",
  "presio_keymap",
  "presio_timer_settings",
  "presio_timer_show_clock",
  "presio_notes_font_scale",
  "presio_annotation_toolbar",
  "presio_pen_style",
  "presio_highlighter_style",
  "presio_lan_address",
  "presio_home_minimal",
  "presio_force_desktop",
];
