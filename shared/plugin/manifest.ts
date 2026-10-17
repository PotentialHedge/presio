// Plugin manifests (presio-plugin.json), version 2 of the format: what a
// plugin is, what it may do and what it adds. Mirrors
// schema/plugin-manifest.schema.json; this is the validator the app, the
// server and the standalone checker all run.
//
// Like a VS Code extension, a plugin never touches Presio's own interface: it
// *declares* what it adds (commands, the buttons and keys that run them,
// panels, settings) and Presio draws it. Its code runs in frames — its
// "surfaces" — and talks to Presio only through `window.presio`.
//
// The validator reports every problem it finds, each as one line naming the
// field ("contributes.buttons[0].command: …") and what would fix it, so a
// person or an agent can fix a manifest in one pass. Fields it doesn't know
// are warnings, not errors: a newer manifest still loads in an older Presio.

import { API_VERSION } from "./protocol.js";
import { parseVersion, parseRange } from "./semver.js";
import { PLUGIN_NAME_RE, parseSource, formatSource } from "./sources.js";
import { sanitizeSettingValue, type PluginSettingSpec } from "./settings.js";

export type { PluginSettingSpec } from "./settings.js";

/** Where a plugin runs. The same HTML runs in each; presio.surface says which. */
export type PluginSurface =
  /** Hidden, on the presenter's device, for as long as the deck is open. The
   *  place to keep state and handle commands. */
  | "background"
  /** Inside the presenter's dashboard cards: one frame per contributed panel
   *  (contributes.panels), presio.panel saying which. */
  | "panel"
  /** On each viewer's device, a bottom sheet on phones and a side card on
   *  wide screens, for the audience to interact with (a poll's answers).
   *  Hidden until the plugin asks to be shown (presio.ui.setVisible), and
   *  the viewer can dismiss it. */
  | "viewerSheet"
  /** A full-screen layer on every viewer screen, hidden until the plugin
   *  asks to be shown (presio.ui.setVisible). */
  | "viewer"
  /** A layer over the slide itself, sized to the page: on the presenter's
   *  current slide and on every viewer. Lets input through unless it asks
   *  for it (presio.ui.setInteractive). */
  | "slide";

export const SURFACES: readonly PluginSurface[] = ["background", "panel", "viewerSheet", "viewer", "slide"];

/**
 * What a "slide" surface covers. "page" (the default): the page itself, so
 * fractions of the frame are page positions. "area": the whole slide area
 * around it — the viewer's screen, the current slide card — letterbox bars
 * included, with presio.ui.page saying where the page is.
 */
export type SlideSurfaceArea = "page" | "area";

export type PluginPermission =
  /** Read the deck: its attachments, its bytes, its page sizes. */
  | "deck"
  /** Save an edited PDF over the deck, from the presenter's device. */
  | "editDeck"
  /** Keep an edit history for the deck, shared with every device, and blobs. */
  | "history"
  /** Collect each viewer's input (presio.audience). Reserved: not yet served. */
  | "audience";

export const PERMISSIONS: readonly PluginPermission[] = ["deck", "editDeck", "history", "audience"];

/** Where a contributed button can go. */
export type ButtonLocation =
  /** The controller's bottom bar, beside Sync All. */
  | "controller.toolbar"
  /** The current slide card's header, as an icon (the label is its tooltip). */
  | "controller.currentSlide"
  /** A thumbnail's context menu (right-click, or a long press); the command gets { slide }. */
  | "thumbnail.context"
  /** The viewer's toolbar, on every audience device; the command runs in
   *  that device's frames (viewerSheet, viewer, slide). */
  | "viewer.toolbar"
  /** The plugin's own page in Settings: for what's used now and then. */
  | "settings";

export const BUTTON_LOCATIONS: readonly ButtonLocation[] = [
  "controller.toolbar",
  "controller.currentSlide",
  "thumbnail.context",
  "viewer.toolbar",
  "settings",
];

/** Where a status item can go. */
export type StatusLocation = "controller.header";
export const STATUS_LOCATIONS: readonly StatusLocation[] = ["controller.header"];

/** Icons a contribution may name (drawn from Presio's own icon set). */
export const PLUGIN_ICONS = [
  "qr-code", "bar-chart", "message", "users", "timer", "bell", "star", "sparkles", "hand", "check", "eye", "megaphone", "pen",
  "download", "upload",
] as const;
export type PluginIcon = (typeof PLUGIN_ICONS)[number];

/**
 * Something the plugin can do, by id: run by its buttons and keybindings, by
 * the command palette, and by other plugins (presio.commands.execute
 * ("<plugin id>.<command>")). The plugin handles it with
 * presio.commands.register(id, handler).
 */
export interface CommandContribution {
  id: string;
  /** What it does, as a palette entry ("Show join code"). */
  title: string;
  icon?: PluginIcon;
  /** Groups it in the palette; the plugin's name by default. */
  category?: string;
}

/** A button Presio draws that runs one of the plugin's commands. */
export interface ButtonContribution {
  command: string;
  location: ButtonLocation;
  /** Its text; the command's title by default. */
  label?: string;
  /** The command's icon by default; buttons without one are text-only. */
  icon?: PluginIcon;
  tooltip?: string;
  /** Ask for a file first, of these types (an <input accept> value): the
   *  command runs with { file }, and doesn't if the presenter cancels. */
  accept?: string;
}

export interface KeyBinding {
  /** A KeyboardEvent.key value. */
  key: string;
  meta?: boolean;
}

/**
 * Default keys for one of the plugin's commands. Shown (and rebindable) in
 * Settings → Keyboard shortcuts; the presenter's own bindings are stored in
 * the "keybindings" setting as "<plugin id>.<command>".
 */
export interface KeybindingContribution {
  command: string;
  /** Presio's own bindings win where they overlap. */
  keys: KeyBinding[];
}

/** A small piece of text Presio shows for the plugin ("12 votes"); the
 *  plugin sets its text at runtime (presio.ui.setStatus), and it's hidden
 *  until it does. */
export interface StatusContribution {
  id: string;
  location: StatusLocation;
  tooltip?: string;
}

/** A card on the presenter's dashboard with the plugin's "panel" surface in it. */
export interface PanelContribution {
  id: string;
  title: string;
}

export interface PluginContributions {
  commands: CommandContribution[];
  buttons: ButtonContribution[];
  keybindings: KeybindingContribution[];
  status: StatusContribution[];
  panels: PanelContribution[];
  /** Stored as "<plugin id>.<name>". */
  settings: Record<string, PluginSettingSpec>;
}

export interface PluginManifest {
  /** The plugin API's major version it's written against. */
  presio: typeof API_VERSION;
  /** A slug: the id's name part where the source doesn't give one (a URL). */
  name: string;
  /** What people see; `name` when absent. */
  displayName: string;
  /** Semver, and equal to the git tag ("v" + version) it's released under. */
  version: string;
  author?: string;
  description?: string;
  /** The plugin's HTML file, relative to the manifest. */
  main: string;
  surfaces: PluginSurface[];
  slideSurface: SlideSurfaceArea;
  /** When it runs for a deck: "always", or "attachment:<glob>" to run only
   *  when the PDF carries a matching attachment. */
  activation: string[];
  permissions: PluginPermission[];
  /** Other plugins it needs, by source ("github:alice/presio-quiz-core") →
   *  semver range ("^1.0.0"). */
  dependencies: Record<string, string>;
  contributes: PluginContributions;
}

export interface ManifestReport {
  /** Set when there are no errors. */
  manifest: PluginManifest | null;
  errors: string[];
  warnings: string[];
}

// --- Validation ---

const COMMAND_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SETTING_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CONTRIBUTION_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const TOP_LEVEL = new Set([
  "$schema", "presio", "name", "displayName", "version", "author", "description", "main", "surfaces", "slideSurface",
  "activation", "permissions", "dependencies", "contributes",
]);
const CONTRIBUTION_KINDS = new Set(["commands", "buttons", "keybindings", "status", "panels", "settings"]);
// Surfaces that are up on the presenter's device whenever the deck is, and
// so can handle the presenter's buttons and keys.
const PRESENTER_HANDLERS: PluginSurface[] = ["background", "panel"];
// Surfaces on audience devices, for viewer.toolbar buttons.
const VIEWER_HANDLERS: PluginSurface[] = ["viewer", "viewerSheet", "slide"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const quote = (v: unknown) => JSON.stringify(v) ?? String(v);
const listOf = (values: readonly string[]) => values.map((v) => `"${v}"`).join(", ");

/** Collects problems at paths ("contributes.buttons[0].label"). */
class Problems {
  errors: string[] = [];
  warnings: string[] = [];
  error(path: string, message: string) {
    this.errors.push(path ? `${path}: ${message}` : message);
  }
  warn(path: string, message: string) {
    this.warnings.push(path ? `${path}: ${message}` : message);
  }
  /** A string field: required or optional, 1..max characters. */
  string(obj: Obj, key: string, path: string, max: number, required: boolean): string | undefined {
    const v = obj[key];
    if (v === undefined) {
      if (required) this.error(path, `required: a string of at most ${max} characters`);
      return undefined;
    }
    if (typeof v !== "string" || !v || v.length > max) {
      this.error(path, `must be a non-empty string of at most ${max} characters (got ${quote(v)})`);
      return undefined;
    }
    return v;
  }
  /** A list field (absent = []), at most `max` long. */
  list(obj: Obj, key: string, path: string, max: number): unknown[] {
    const v = obj[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      this.error(path, `must be a list (got ${quote(v)})`);
      return [];
    }
    if (v.length > max) this.error(path, `at most ${max} entries (got ${v.length})`);
    return v.slice(0, max);
  }
  unknownKeys(obj: Obj, known: Set<string> | readonly string[], path: string) {
    const set = known instanceof Set ? known : new Set(known);
    for (const key of Object.keys(obj)) {
      if (!set.has(key)) this.warn(path ? `${path}.${key}` : key, "unknown field, ignored (a typo?)");
    }
  }
}

/** Validate a parsed presio-plugin.json, reporting every problem found. */
export function validateManifest(raw: unknown): ManifestReport {
  const p = new Problems();
  if (!isObj(raw)) {
    p.error("", "presio-plugin.json must be a JSON object");
    return { manifest: null, errors: p.errors, warnings: p.warnings };
  }
  const m = raw;
  p.unknownKeys(m, TOP_LEVEL, "");

  if (m.presio === undefined) {
    p.error("presio", `required: the plugin API version it's written for — add "presio": ${API_VERSION}`);
  } else if (m.presio !== API_VERSION) {
    p.error(
      "presio",
      typeof m.presio === "number" && m.presio > API_VERSION
        ? `this Presio runs API version ${API_VERSION}, and the plugin needs ${m.presio}: it's for a newer Presio`
        : `must be ${API_VERSION} (got ${quote(m.presio)})`
    );
  }

  const name = p.string(m, "name", "name", 64, true);
  if (name !== undefined && !PLUGIN_NAME_RE.test(name)) {
    p.error("name", `must be a slug: lowercase letters, digits and dashes, starting with a letter or digit (got ${quote(name)}); put the readable name in "displayName"`);
  }
  const displayName = p.string(m, "displayName", "displayName", 80, false);
  const version = p.string(m, "version", "version", 32, true);
  if (version !== undefined && !parseVersion(version)) {
    p.error("version", `must be a semver version like "1.0.0" (got ${quote(version)}); release it under the tag "v" + version`);
  } else if (version?.startsWith("v")) {
    p.error("version", `drop the "v": the version is ${quote(version.slice(1))}, its tag is ${quote(version)}`);
  }
  const author = p.string(m, "author", "author", 80, false);
  const description = p.string(m, "description", "description", 300, false);
  const main = p.string(m, "main", "main", 200, false) ?? "index.html";
  if (/^[a-z]+:|^\/|\.\./i.test(main)) p.error("main", `must be a path relative to presio-plugin.json, like "index.html" (got ${quote(main)})`);

  const surfaces = enumList(p, m, "surfaces", SURFACES, 5);
  if (!surfaces.length) p.error("surfaces", `required: where the plugin runs, one or more of ${listOf(SURFACES)}`);
  const slideSurface = m.slideSurface ?? "page";
  if (slideSurface !== "page" && slideSurface !== "area") p.error("slideSurface", `must be "page" or "area" (got ${quote(slideSurface)})`);
  else if (m.slideSurface !== undefined && !surfaces.includes("slide")) p.warn("slideSurface", 'only matters with a "slide" surface');

  const activation = p.list(m, "activation", "activation", 16).flatMap((rule, i): string[] => {
    if (typeof rule === "string" && (rule === "always" || /^attachment:.{1,200}$/.test(rule))) return [rule];
    p.error(`activation[${i}]`, `must be "always" or "attachment:<glob>", like "attachment:poll-*.json" (got ${quote(rule)})`);
    return [];
  });
  const permissions = enumList(p, m, "permissions", PERMISSIONS, 8);
  const dependencies = parseDependencies(p, m.dependencies);
  const contributes = parseContributes(p, m.contributes, surfaces);

  if (p.errors.length) return { manifest: null, errors: p.errors, warnings: p.warnings };
  return {
    manifest: {
      presio: API_VERSION,
      name: name!,
      displayName: displayName ?? name!,
      version: version!,
      author,
      description,
      main,
      surfaces,
      slideSurface: slideSurface as SlideSurfaceArea,
      activation: m.activation === undefined ? ["always"] : activation,
      permissions,
      dependencies,
      contributes,
    },
    errors: [],
    warnings: p.warnings,
  };
}

/** Validate a parsed presio-plugin.json, throwing every problem as one Error. */
export function parseManifest(raw: unknown): PluginManifest {
  const report = validateManifest(raw);
  if (!report.manifest) {
    const [first, ...rest] = report.errors;
    throw new Error(`presio-plugin.json: ${first}${rest.length ? `; ${rest.join("; ")}` : ""}`);
  }
  return report.manifest;
}

/** A list of strings from a fixed set, without duplicates. */
function enumList<T extends string>(p: Problems, obj: Obj, key: string, allowed: readonly T[], max: number): T[] {
  const out: T[] = [];
  p.list(obj, key, key, max).forEach((v, i) => {
    if (typeof v !== "string" || !allowed.includes(v as T)) {
      // The one rename from the first manifest format.
      const hint = key === "surfaces" && v === "tile" ? ' ("tile" is now "panel", with a contributes.panels entry)' : "";
      p.error(`${key}[${i}]`, `unknown value ${quote(v)}: use one of ${listOf(allowed)}${hint}`);
    } else if (out.includes(v as T)) {
      p.warn(`${key}[${i}]`, `${quote(v)} is listed twice`);
    } else {
      out.push(v as T);
    }
  });
  return out;
}

function parseDependencies(p: Problems, raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  if (!isObj(raw)) {
    p.error("dependencies", 'must be an object of plugin source → version range, like { "github:alice/presio-quiz-core": "^1.0.0" }');
    return out;
  }
  const entries = Object.entries(raw);
  if (entries.length > 16) p.error("dependencies", `at most 16 (got ${entries.length})`);
  for (const [spec, range] of entries.slice(0, 16)) {
    const at = `dependencies[${quote(spec)}]`;
    try {
      const source = parseSource(spec);
      if (source.kind === "url") p.warn(at, "a URL dependency can't be pinned to a version; prefer a GitHub source");
      if (source.kind === "github" && source.ref) p.error(at, `put the version in the range, not the source: ${quote(formatSource({ ...source, ref: undefined }))}`);
    } catch (e) {
      p.error(at, e instanceof Error ? e.message : String(e));
    }
    if (typeof range !== "string" || !parseRange(range)) {
      p.error(at, `must be a version range like "^1.0.0", "~1.2.0", "1.x" or "1.2.3" (got ${quote(range)})`);
    } else {
      out[spec] = range;
    }
  }
  return out;
}

function parseContributes(p: Problems, raw: unknown, surfaces: PluginSurface[]): PluginContributions {
  const out: PluginContributions = { commands: [], buttons: [], keybindings: [], status: [], panels: [], settings: {} };
  if (raw === undefined) {
    if (surfaces.includes("panel")) p.error("contributes.panels", 'the "panel" surface needs at least one panel to draw it in');
    return out;
  }
  if (!isObj(raw)) {
    p.error("contributes", "must be an object");
    return out;
  }
  p.unknownKeys(raw, CONTRIBUTION_KINDS, "contributes");
  const has = (list: PluginSurface[]) => list.some((s) => surfaces.includes(s));

  // Commands first: buttons and keybindings name them.
  p.list(raw, "commands", "contributes.commands", 64).forEach((c, i) => {
    const at = `contributes.commands[${i}]`;
    if (!isObj(c)) return p.error(at, 'must be an object like { "id": "toggle", "title": "Show join code" }');
    p.unknownKeys(c, ["id", "title", "icon", "category"], at);
    const id = c.id;
    if (typeof id !== "string" || !COMMAND_RE.test(id)) {
      return p.error(`${at}.id`, `must start with a letter, then letters, digits, "_" or "-" (got ${quote(id)})`);
    }
    if (out.commands.some((x) => x.id === id)) return p.error(`${at}.id`, `duplicate command ${quote(id)}`);
    const title = p.string(c, "title", `${at}.title`, 64, true);
    const icon = parseIcon(p, c.icon, `${at}.icon`);
    const category = p.string(c, "category", `${at}.category`, 40, false);
    if (title) out.commands.push({ id, title, icon, category });
  });
  const commandIds = new Set(out.commands.map((c) => c.id));
  const commandRef = (value: unknown, at: string): string | null => {
    if (typeof value !== "string" || !value) {
      p.error(at, 'required: the id of a command in "contributes.commands"');
      return null;
    }
    if (!commandIds.has(value)) {
      p.error(at, `no command ${quote(value)} in contributes.commands — declare it there ({ "id": ${quote(value)}, "title": "…" })`);
      return null;
    }
    return value;
  };

  p.list(raw, "buttons", "contributes.buttons", 8).forEach((b, i) => {
    const at = `contributes.buttons[${i}]`;
    if (!isObj(b)) return p.error(at, 'must be an object like { "command": "toggle", "location": "controller.toolbar" }');
    p.unknownKeys(b, ["command", "location", "label", "icon", "tooltip", "accept"], at);
    const command = commandRef(b.command, `${at}.command`);
    const location = b.location as ButtonLocation;
    if (!BUTTON_LOCATIONS.includes(location)) {
      return p.error(`${at}.location`, `must be one of ${listOf(BUTTON_LOCATIONS)} (got ${quote(b.location)})`);
    }
    const label = p.string(b, "label", `${at}.label`, 24, false);
    const icon = parseIcon(p, b.icon, `${at}.icon`);
    const tooltip = p.string(b, "tooltip", `${at}.tooltip`, 120, false);
    const accept = p.string(b, "accept", `${at}.accept`, 200, false);
    if (location === "viewer.toolbar" ? !has(VIEWER_HANDLERS) : !has(PRESENTER_HANDLERS)) {
      const need = location === "viewer.toolbar" ? VIEWER_HANDLERS : PRESENTER_HANDLERS;
      p.error(at, `a ${location} button needs a surface to run its command in: add one of ${listOf(need)} to "surfaces"`);
    }
    if (accept && location === "viewer.toolbar") p.error(`${at}.accept`, "viewer.toolbar buttons can't ask for a file");
    if (command && out.buttons.some((x) => x.command === command && x.location === location)) {
      return p.error(at, `a second ${location} button for ${quote(command)}`);
    }
    if (command) out.buttons.push({ command, location, label, icon, tooltip, accept });
  });

  p.list(raw, "keybindings", "contributes.keybindings", 32).forEach((k, i) => {
    const at = `contributes.keybindings[${i}]`;
    if (!isObj(k)) return p.error(at, 'must be an object like { "command": "toggle", "keys": [{ "key": "c" }] }');
    p.unknownKeys(k, ["command", "keys"], at);
    const command = commandRef(k.command, `${at}.command`);
    const keys = p.list(k, "keys", `${at}.keys`, 3).flatMap((rawKey, j): KeyBinding[] => {
      const kat = `${at}.keys[${j}]`;
      if (!isObj(rawKey) || typeof rawKey.key !== "string" || !rawKey.key || rawKey.key.length > 32) {
        p.error(kat, 'must be { "key": <a KeyboardEvent.key value, like "c" or "ArrowUp">, "meta"?: true }');
        return [];
      }
      if (rawKey.meta !== undefined && typeof rawKey.meta !== "boolean") p.error(`${kat}.meta`, "must be true or false");
      return [rawKey.meta === true ? { key: rawKey.key, meta: true } : { key: rawKey.key }];
    });
    if (!has(PRESENTER_HANDLERS)) p.error(at, `keybindings need a surface to run their command in: add one of ${listOf(PRESENTER_HANDLERS)} to "surfaces"`);
    if (command && out.keybindings.some((x) => x.command === command)) return p.error(`${at}.command`, `${quote(command)} has keybindings already; list all its keys in one entry`);
    if (command) out.keybindings.push({ command, keys });
  });

  p.list(raw, "status", "contributes.status", 4).forEach((s, i) => {
    const at = `contributes.status[${i}]`;
    if (!isObj(s)) return p.error(at, 'must be an object like { "id": "votes", "location": "controller.header" }');
    p.unknownKeys(s, ["id", "location", "tooltip"], at);
    if (typeof s.id !== "string" || !CONTRIBUTION_ID_RE.test(s.id)) return p.error(`${at}.id`, `must start with a letter, then letters, digits, "_" or "-" (got ${quote(s.id)})`);
    if (!STATUS_LOCATIONS.includes(s.location as StatusLocation)) return p.error(`${at}.location`, `must be one of ${listOf(STATUS_LOCATIONS)} (got ${quote(s.location)})`);
    if (out.status.some((x) => x.id === s.id)) return p.error(`${at}.id`, `duplicate status item ${quote(s.id)}`);
    if (!has(PRESENTER_HANDLERS)) p.error(at, `status items are set from the presenter's device: add one of ${listOf(PRESENTER_HANDLERS)} to "surfaces"`);
    out.status.push({ id: s.id, location: s.location as StatusLocation, tooltip: p.string(s, "tooltip", `${at}.tooltip`, 120, false) });
  });

  p.list(raw, "panels", "contributes.panels", 4).forEach((panel, i) => {
    const at = `contributes.panels[${i}]`;
    if (!isObj(panel)) return p.error(at, 'must be an object like { "id": "main", "title": "Timer" }');
    p.unknownKeys(panel, ["id", "title"], at);
    if (typeof panel.id !== "string" || !CONTRIBUTION_ID_RE.test(panel.id)) return p.error(`${at}.id`, `must start with a letter, then letters, digits, "_" or "-" (got ${quote(panel.id)})`);
    if (out.panels.some((x) => x.id === panel.id)) return p.error(`${at}.id`, `duplicate panel ${quote(panel.id)}`);
    const title = p.string(panel, "title", `${at}.title`, 40, true);
    if (title) out.panels.push({ id: panel.id, title });
  });
  if (out.panels.length && !surfaces.includes("panel")) p.error("contributes.panels", 'panels show the "panel" surface: add "panel" to "surfaces"');
  if (!out.panels.length && surfaces.includes("panel")) p.error("contributes.panels", 'the "panel" surface needs at least one panel to draw it in, like { "id": "main", "title": "…" }');

  if (raw.settings !== undefined) {
    if (!isObj(raw.settings)) {
      p.error("contributes.settings", 'must be an object of name → spec, like { "showClock": { "type": "boolean", "default": false } }');
    } else {
      const entries = Object.entries(raw.settings);
      if (entries.length > 32) p.error("contributes.settings", `at most 32 (got ${entries.length})`);
      for (const [name, spec] of entries.slice(0, 32)) {
        const at = `contributes.settings.${name}`;
        if (!SETTING_RE.test(name)) {
          p.error(at, "a setting's name starts with a letter, then letters, digits or \"_\"");
          continue;
        }
        const parsed = parseSettingSpec(p, spec, at);
        if (parsed) out.settings[name] = parsed;
      }
    }
  }
  return out;
}

function parseIcon(p: Problems, raw: unknown, at: string): PluginIcon | undefined {
  if (raw === undefined) return undefined;
  if (!(PLUGIN_ICONS as readonly unknown[]).includes(raw)) {
    p.error(at, `unknown icon ${quote(raw)}: use one of ${listOf(PLUGIN_ICONS)}, or leave it out`);
    return undefined;
  }
  return raw as PluginIcon;
}

function parseSettingSpec(p: Problems, raw: unknown, at: string): PluginSettingSpec | null {
  if (!isObj(raw)) {
    p.error(at, 'must be an object like { "type": "boolean", "default": false, "description": "…" }');
    return null;
  }
  const description = p.string(raw, "description", `${at}.description`, 300, false);
  let spec: PluginSettingSpec;
  switch (raw.type) {
    case "boolean":
      p.unknownKeys(raw, ["type", "default", "description"], at);
      spec = { type: "boolean", default: raw.default as boolean, description };
      break;
    case "number": {
      p.unknownKeys(raw, ["type", "default", "minimum", "maximum", "description"], at);
      const bound = (key: "minimum" | "maximum") => {
        const v = raw[key];
        if (v === undefined) return undefined;
        if (typeof v !== "number" || !Number.isFinite(v)) p.error(`${at}.${key}`, "must be a number");
        return typeof v === "number" ? v : undefined;
      };
      spec = { type: "number", default: raw.default as number, minimum: bound("minimum"), maximum: bound("maximum"), description };
      break;
    }
    case "string": {
      p.unknownKeys(raw, ["type", "default", "maxLength", "description"], at);
      const max = raw.maxLength;
      if (max !== undefined && !(typeof max === "number" && Number.isInteger(max) && max > 0 && max <= 1000)) {
        p.error(`${at}.maxLength`, "must be a whole number from 1 to 1000");
      }
      spec = { type: "string", default: raw.default as string, maxLength: typeof max === "number" ? Math.min(max, 1000) : 1000, description };
      break;
    }
    case "enum": {
      p.unknownKeys(raw, ["type", "default", "values", "labels", "description"], at);
      const values = raw.values;
      if (!Array.isArray(values) || !values.length || !values.every((v) => typeof v === "string")) {
        p.error(`${at}.values`, "an enum needs \"values\", a non-empty list of strings");
        return null;
      }
      const labels = raw.labels;
      if (labels !== undefined && !(Array.isArray(labels) && labels.length === values.length && labels.every((v) => typeof v === "string"))) {
        p.error(`${at}.labels`, `must be a list of ${values.length} strings, one per value`);
      }
      spec = { type: "enum", default: raw.default as string, values: values as string[], labels: Array.isArray(labels) ? (labels as string[]) : undefined, description };
      break;
    }
    default:
      p.error(`${at}.type`, `must be "boolean", "number", "string" or "enum" (got ${quote(raw.type)})`);
      return null;
  }
  // The default has to satisfy its own spec, or every read would be invalid.
  if (sanitizeSettingValue(spec, spec.default) === undefined) {
    p.error(`${at}.default`, `${quote(raw.default)} doesn't fit its own spec${spec.type === "number" ? " (a number in range, or null)" : ""}`);
    return null;
  }
  return spec;
}

// --- Helpers for hosts ---

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Whether a plugin should run for a deck with these attachment filenames. */
export function isActivatedBy(manifest: Pick<PluginManifest, "activation">, attachmentNames: readonly string[]): boolean {
  return manifest.activation.some((rule) => {
    if (rule === "always") return true;
    if (rule.startsWith("attachment:")) {
      const re = globToRegExp(rule.slice("attachment:".length));
      return attachmentNames.some((name) => re.test(name));
    }
    return false;
  });
}

/** A command's declaration, by id. */
export function findCommand(manifest: Pick<PluginManifest, "contributes">, id: string): CommandContribution | undefined {
  return manifest.contributes.commands.find((c) => c.id === id);
}
