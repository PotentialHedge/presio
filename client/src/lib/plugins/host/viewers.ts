// presio.viewers: which viewers run a plugin, for the presenter's frames to
// talk to one at a time (presio.messages.send with `to`). A viewer joins a
// plugin when the plugin's first frame on that device connects — so a message
// sent on join lands — and leaves when its last one goes, or the device does.
//
// On a viewer, this module reports the plugins it has frames for (through the
// transport usePluginHost supplies); on the presenter, it holds who runs what
// and tells the plugin's frames as that changes.

import type { HostCore } from "./types";

/** How long a viewer waits before saying a plugin stopped: a frame remounting
 *  (a layout change) shouldn't read as leaving and joining again. */
const LEAVE_DELAY_MS = 1000;

export class Viewers {
  private core: HostCore;
  /** Presenter: viewer ids by plugin. */
  private byPlugin = new Map<string, Set<string>>();
  /** Viewer: where this device's running plugins go, and what it last said. */
  private report: ((plugins: string[]) => void) | null = null;
  private reported: string | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(core: HostCore) {
    this.core = core;
  }

  /** Presenter: the viewers running a plugin, for a frame's context. */
  of(pluginId: string): string[] {
    return [...(this.byPlugin.get(pluginId) ?? [])];
  }

  /** Presenter: who runs what, all of it (on joining the session). */
  reset(entries: { plugin: string; viewer: string }[]) {
    const next = new Map<string, Set<string>>();
    for (const { plugin, viewer } of entries) next.set(plugin, (next.get(plugin) ?? new Set()).add(viewer));
    const plugins = new Set([...this.byPlugin.keys(), ...next.keys()]);
    const prev = this.byPlugin;
    this.byPlugin = next;
    for (const plugin of plugins) {
      const before = prev.get(plugin) ?? new Set<string>();
      const after = next.get(plugin) ?? new Set<string>();
      for (const viewer of before) if (!after.has(viewer)) this.tell(plugin, viewer, false);
      for (const viewer of after) if (!before.has(viewer)) this.tell(plugin, viewer, true);
    }
  }

  /** Presenter: a viewer started or stopped running a plugin. */
  change(plugin: string, viewer: string, here: boolean) {
    const ids = this.byPlugin.get(plugin) ?? new Set<string>();
    if (ids.has(viewer) === here) return;
    if (here) ids.add(viewer);
    else ids.delete(viewer);
    if (ids.size) this.byPlugin.set(plugin, ids);
    else this.byPlugin.delete(plugin);
    this.tell(plugin, viewer, here);
  }

  /** Presenter: the plugins one viewer runs now, all of them. */
  setFor(viewer: string, plugins: string[]) {
    for (const [plugin, ids] of [...this.byPlugin]) if (ids.has(viewer) && !plugins.includes(plugin)) this.change(plugin, viewer, false);
    for (const plugin of plugins) this.change(plugin, viewer, true);
  }

  private tell(plugin: string, viewer: string, here: boolean) {
    for (const conn of this.core.framesOf(plugin)) this.core.emit(conn, here ? "viewers.join" : "viewers.leave", { viewer });
  }

  /** Viewer: where to report the plugins it has frames for; null stops. */
  setReport(report: ((plugins: string[]) => void) | null) {
    this.report = report;
    this.resend();
  }

  /** Viewer: say again what runs here (the server may have forgotten). */
  resend() {
    this.reported = null;
    this.framesChanged();
  }

  /** A frame connected or went: a viewer reports a new plugin at once, and
   *  one that stopped after LEAVE_DELAY_MS, unless it's back by then. */
  framesChanged() {
    if (this.core.ctx.role !== "audience" || !this.report) return;
    const plugins = this.running();
    const before = this.reported?.split(",").filter(Boolean);
    if (before && plugins.length < before.length && plugins.every((p) => before.includes(p))) {
      this.leaveTimer ??= setTimeout(() => this.send(this.running()), LEAVE_DELAY_MS);
      return;
    }
    this.send(plugins);
  }

  private running(): string[] {
    return [...new Set([...this.core.frames()].map((c) => c.plugin.id))].sort();
  }

  private send(plugins: string[]) {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    const key = plugins.join(",");
    if (key === this.reported || !this.report) return;
    this.reported = key;
    this.report(plugins);
  }
}
