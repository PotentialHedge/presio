// presio.ui: how a frame is shown (a viewer layer's visibility, where a slide
// layer takes input) and the state of the buttons Presio draws for the
// plugin's commands.

import { asRecord } from "../manifest";
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

/** How many rows a button's menu may have. */
const MAX_MENU_ENTRIES = 32;
const NO_BUTTONS: Record<string, ButtonState> = {};

export class Ui {
  private core: HostCore;
  // Button state by plugin id, then command.
  private buttons = new Map<string, Record<string, ButtonState>>();
  private listeners = new Set<() => void>();

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
