// presio.ui: how a frame is shown (a viewer layer's or sheet's visibility,
// where a slide layer takes input), the state of the buttons Presio draws for
// the plugin's commands, and its status items' text.

import { asRecord, findCommand, PLUGIN_ICONS, type PluginIcon } from "../manifest";
import { HostError, parseRect, requireString, type HostCore, type Interactive, type MethodTable } from "./types";

/** What a plugin has set on the buttons for one of its commands. */
export interface ButtonState {
  active?: boolean;
  label?: string;
  disabled?: boolean;
  /** A small menu beside the button (a mic to use, a mode): picking an item
   *  runs the command with { menuItem }. */
  menu?: ButtonMenuEntry[];
}

/** One row of a button's menu: an item to pick, a heading, or a divider. */
export type ButtonMenuEntry =
  | { id: string; label: string; checked?: boolean; disabled?: boolean }
  | { heading: string }
  | { separator: true };

/** A status item as the plugin last set it (presio.ui.setStatus). */
export interface StatusState {
  text: string;
  tooltip?: string;
  icon?: PluginIcon;
  /** One of the plugin's commands, run by a click on the item. */
  command?: string;
  /** What the command runs with. */
  args?: unknown;
}

/** How many rows a button's menu may have. */
const MAX_MENU_ENTRIES = 32;
const NO_BUTTONS: Record<string, ButtonState> = {};
const NO_STATUS: Record<string, StatusState> = {};

export class Ui {
  private core: HostCore;
  // Button state by plugin id, then command.
  private buttons = new Map<string, Record<string, ButtonState>>();
  private listeners = new Set<() => void>();
  // Status items by plugin id, then item id.
  private status = new Map<string, Record<string, StatusState>>();
  private statusListeners = new Set<() => void>();
  /** Bumped on every change to any plugin's status items. */
  statusRevision = 0;

  constructor(core: HostCore) {
    this.core = core;
  }

  readonly methods: MethodTable = {
    "ui.setVisible": {
      handler: (conn, p) => {
        conn.onVisible?.(p.visible === true);
        return null;
      },
    },
    "ui.setInteractive": {
      handler: (conn, p) => {
        conn.onInteractive?.(sanitizeInteractive(p.value));
        return null;
      },
    },
    "ui.setButton": {
      handler: (conn, p) => {
        const command = requireString(p, "command", "ui.setButton");
        const { manifest, id } = conn.plugin;
        const buttons = manifest.contributes.buttons.filter((b) => b.command === command);
        if (!buttons.length) throw new HostError("InvalidParams", `No button runs "${command}" in contributes.buttons`);
        // The same code runs on every device; a button only exists where it's
        // drawn (the audience's toolbar, or the presenter's controls).
        const audience = this.core.ctx.role === "audience";
        if (!buttons.some((b) => (b.location === "viewer.toolbar") === audience)) return null;
        const s = asRecord(p.state);
        const next: ButtonState = {
          active: typeof s.active === "boolean" ? s.active : undefined,
          label: typeof s.label === "string" ? s.label.slice(0, 24) : undefined,
          disabled: typeof s.disabled === "boolean" ? s.disabled : undefined,
          menu: sanitizeMenu(s.menu),
        };
        this.buttons.set(id, { ...this.buttons.get(id), [command]: next });
        this.listeners.forEach((l) => l());
        return null;
      },
    },
    "ui.setStatus": {
      handler: (conn, p) => {
        const item = requireString(p, "id", "ui.setStatus");
        const { manifest, id } = conn.plugin;
        if (!manifest.contributes.status.some((s) => s.id === item)) {
          throw new HostError("InvalidParams", `No status item "${item}" in contributes.status`);
        }
        // Status items are drawn in the controller only.
        if (this.core.ctx.role !== "presenter") return null;
        const next = { ...this.status.get(id) };
        if (p.status === null || p.status === undefined) {
          delete next[item];
        } else {
          const s = asRecord(p.status);
          if (typeof s.text !== "string") throw new HostError("InvalidParams", "ui.setStatus needs { text } (a string), or null to hide the item");
          const command = typeof s.command === "string" ? s.command : undefined;
          if (command && !findCommand(manifest, command)) {
            throw new HostError("InvalidParams", `No command "${command}" in contributes.commands`);
          }
          if (s.icon !== undefined && !(PLUGIN_ICONS as readonly unknown[]).includes(s.icon)) {
            throw new HostError("InvalidParams", `Unknown icon ${JSON.stringify(s.icon)}: use one of ${PLUGIN_ICONS.join(", ")}`);
          }
          const tooltip = typeof s.tooltip === "string" ? s.tooltip.slice(0, 120) : undefined;
          // An empty text hides the item, as null does.
          if (!s.text.trim()) delete next[item];
          else next[item] = { text: s.text.slice(0, 64), tooltip, icon: s.icon as PluginIcon | undefined, command, args: s.args };
        }
        this.status.set(id, next);
        this.statusChanged();
        return null;
      },
    },
  };

  /** A plugin's status items as it last set them, by item id; a stable
   *  object until it changes. */
  statusItems(pluginId: string): Record<string, StatusState> {
    return this.status.get(pluginId) ?? NO_STATUS;
  }

  /** Forget the status items of plugins that stopped running: one switched
   *  back on sets its own again. */
  keepOnly(pluginIds: readonly string[]) {
    let changed = false;
    for (const id of this.status.keys()) {
      if (pluginIds.includes(id)) continue;
      this.status.delete(id);
      changed = true;
    }
    if (changed) this.statusChanged();
  }

  private statusChanged() {
    this.statusRevision++;
    this.statusListeners.forEach((l) => l());
  }

  subscribeStatus = (listener: () => void) => {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  };

  /** State the plugin gave its buttons, by command; a stable object until it changes. */
  buttonStates(pluginId: string): Record<string, ButtonState> {
    return this.buttons.get(pluginId) ?? NO_BUTTONS;
  }

  subscribeButtons = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}

function sanitizeInteractive(value: unknown): Interactive {
  if (typeof value === "boolean" || value === "pen") return value;
  if (!Array.isArray(value)) return false;
  return value.slice(0, 32).flatMap((raw) => parseRect(asRecord(raw)) ?? []);
}

/** A button menu as a plugin set it, reduced to rows Presio can draw. */
function sanitizeMenu(raw: unknown): ButtonMenuEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const entries: ButtonMenuEntry[] = [];
  for (const r of raw.slice(0, MAX_MENU_ENTRIES)) {
    if (typeof r !== "object" || r === null) continue;
    const e = r as Record<string, unknown>;
    if (e.separator === true) entries.push({ separator: true });
    else if (typeof e.heading === "string" && e.heading) entries.push({ heading: e.heading.slice(0, 64) });
    else if (typeof e.id === "string" && e.id && e.id.length <= 256 && typeof e.label === "string" && e.label) {
      entries.push({
        id: e.id,
        label: e.label.slice(0, 64),
        checked: typeof e.checked === "boolean" ? e.checked : undefined,
        disabled: typeof e.disabled === "boolean" ? e.disabled : undefined,
      });
    }
  }
  return entries.length ? entries : undefined;
}
