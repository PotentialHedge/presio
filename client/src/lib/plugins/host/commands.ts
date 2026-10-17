// presio.commands: what a plugin can do, by id. A frame registers a handler
// for each of its commands; Presio runs them from the plugin's buttons,
// keybindings and the command palette, and plugins run each other's (or
// their own) with presio.commands.execute("<plugin id>.<command>", args).
// Routed on this device only: a command runs in a frame here, and resolves to
// whatever its handler returns.
//
// Presio's own actions are commands too ("presio.nextSlide"): the page that
// hosts the plugins hands them in (setAppCommands), and the ones it marks
// as exposed can be run by plugins.

import { formatBinding, pluginBindings, DEFAULT_KEYMAP, type Keymap } from "@/lib/keymap";
import { PLUGIN_ID_RE, splitQualified } from "@shared/plugin/sources";
import type { LoadedPlugin } from "../manifest";
import { HostError, primaryFrame, requireString, type HostCore, type MethodTable } from "./types";

/** How long a command's handler may take. */
const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Presio's own commands' prefix: "presio.nextSlide". Plugin ids always have
 *  a "/", so this never names a plugin's command. */
export const APP_COMMAND_PREFIX = "presio.";

/** One of Presio's own commands, as plugins may run it. */
export interface AppCommandHandler {
  /** Plugins may run it (presio.commands.execute("presio.<id>", args)). */
  exposed?: boolean;
  run(args: Record<string, unknown>): unknown;
}

export class Commands {
  private core: HostCore;
  private keymap: Keymap = DEFAULT_KEYMAP;
  private app: (id: string) => AppCommandHandler | undefined = () => undefined;
  // Bumped whenever a frame registers or drops a command, so the palette can
  // redraw (useSyncExternalStore reads the version).
  private version = 0;
  private listeners = new Set<() => void>();

  constructor(core: HostCore) {
    this.core = core;
  }

  readonly methods: MethodTable = {
    "commands.register": {
      handler: (conn, p) => {
        const command = requireString(p, "command", "commands.register");
        if (!COMMAND_RE.test(command)) throw new HostError("InvalidParams", `"${command}" isn't a command id: a letter, then letters, digits, "_" or "-"`);
        conn.commands.add(command);
        this.changed();
        return null;
      },
    },
    "commands.unregister": {
      handler: (conn, p) => {
        conn.commands.delete(requireString(p, "command", "commands.unregister"));
        this.changed();
        return null;
      },
    },
    "commands.execute": {
      handler: (conn, p) => {
        const full = requireString(p, "command", "commands.execute");
        if (full.startsWith(APP_COMMAND_PREFIX) && !full.includes("/")) {
          return this.executeApp(full.slice(APP_COMMAND_PREFIX.length), p.args);
        }
        // A bare command is the caller's own.
        const target = full.includes("/") ? splitQualified(full) : { pluginId: conn.plugin.id, name: full };
        if (!target) throw new HostError("InvalidParams", `"${full}" isn't a command: use "<plugin id>.<command>", like "presio/drawing.undo", or "presio.nextSlide"`);
        return this.execute(target.pluginId, target.name, p.args);
      },
    },
  };

  /**
   * Run one of a plugin's commands on this device: in the frame that
   * registered it (see primaryFrame). Rejects with a HostError when no frame
   * here handles it.
   */
  execute(pluginId: string, command: string, args?: unknown): Promise<unknown> {
    if (!PLUGIN_ID_RE.test(pluginId)) return Promise.reject(new HostError("InvalidParams", `"${pluginId}" isn't a plugin id`));
    const frames = this.core.framesOf(pluginId);
    if (!frames.length) return Promise.reject(new HostError("Unavailable", `Plugin "${pluginId}" isn't running here`));
    const conn = primaryFrame(frames.filter((c) => c.commands.has(command)));
    if (!conn) return Promise.reject(new HostError("Unavailable", `"${pluginId}.${command}" has no handler (presio.commands.register) here`));
    return this.core.call(conn, "commands.run", { command, args: args ?? null }, COMMAND_TIMEOUT_MS);
  }

  /** Run a command from Presio's interface (a button, a key, the palette):
   *  nobody awaits it, so a failure is logged rather than thrown. */
  run(pluginId: string, command: string, args?: unknown) {
    this.execute(pluginId, command, args).catch((e) => console.warn(`Plugin command ${pluginId}.${command} failed:`, e));
  }

  /** One of Presio's own commands, for a plugin. */
  private async executeApp(id: string, args: unknown): Promise<unknown> {
    const command = this.app(id);
    if (!command?.exposed) throw new HostError("Unavailable", `"${APP_COMMAND_PREFIX}${id}" isn't a command plugins can run here`);
    const params = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    return (await command.run(params)) ?? null;
  }

  /** Where Presio's own commands come from: looked up on each call, so the
   *  page can hand in a function that reads its latest state. */
  setAppCommands(lookup: (id: string) => AppCommandHandler | undefined) {
    this.app = lookup;
  }

  /** Whether a frame here handles one of a plugin's commands. */
  isRegistered(pluginId: string, command: string): boolean {
    return this.core.framesOf(pluginId).some((c) => c.commands.has(command));
  }

  /** A frame registered or dropped commands, or closed. */
  changed() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  get registrations(): number {
    return this.version;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Each of a plugin's commands' key, as the presenter sees it ("E", "⌘Z"). */
  shortcuts(plugin: LoadedPlugin): Record<string, string> {
    const out: Record<string, string> = {};
    for (const kb of plugin.manifest.contributes.keybindings) {
      const first = pluginBindings(this.keymap, plugin.id, kb)[0];
      if (first) out[kb.command] = formatBinding(first);
    }
    return out;
  }

  /** The presenter's keyboard shortcuts changed (presio.commands.shortcut). */
  setKeymap(keymap: Keymap) {
    if (keymap === this.keymap) return;
    this.keymap = keymap;
    for (const conn of this.core.frames()) this.core.emit(conn, "commands.shortcuts", { shortcuts: this.shortcuts(conn.plugin) });
  }
}
