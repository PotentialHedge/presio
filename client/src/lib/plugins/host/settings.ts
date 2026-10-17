// presio.settings: a plugin's settings (contributes.settings), as the
// presenter set them — viewers get the presenter's values.

import { sanitizeSettingValue, setPluginSetting } from "@/lib/settings";
import { HostError, requireString, type HostCore, type MethodTable } from "./types";

export class Settings {
  private core: HostCore;
  private values = new Map<string, Record<string, unknown>>();

  constructor(core: HostCore) {
    this.core = core;
  }

  readonly methods: MethodTable = {
    "settings.set": {
      handler: (conn, p) => {
        if (this.core.ctx.role !== "presenter") throw new HostError("Unavailable", "Only the presenter can change settings");
        const name = requireString(p, "name", "settings.set");
        const { manifest, id } = conn.plugin;
        const spec = manifest.contributes.settings[name];
        if (!spec) throw new HostError("InvalidParams", `No setting "${name}" in contributes.settings`);
        if (sanitizeSettingValue(spec, p.value) === undefined) throw new HostError("InvalidParams", `Invalid value for "${name}"`);
        setPluginSetting(id, name, spec, p.value);
        return null;
      },
    },
  };

  of(pluginId: string): Record<string, unknown> {
    return this.values.get(pluginId) ?? {};
  }

  /** A plugin's resolved settings changed (or arrived from the presenter). */
  set(pluginId: string, values: Record<string, unknown>) {
    const prev = this.values.get(pluginId);
    if (prev && JSON.stringify(prev) === JSON.stringify(values)) return;
    this.values.set(pluginId, values);
    for (const conn of this.core.framesOf(pluginId)) this.core.emit(conn, "settings.change", { settings: values });
  }
}
