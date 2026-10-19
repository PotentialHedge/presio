// presio.storage: the presenter's small per-session plugin state, kept in
// this browser and shared between the plugin's frames here. It never leaves
// the device.

import { lsGet, lsSet, pluginStateKey } from "@/lib/storage";
import { MESSAGE_TYPE_RE } from "@shared/plugin/protocol";
import { jsonBytes } from "@shared/limits";
import { HostError, type HostCore, type MethodTable } from "./types";

/** What one plugin may keep in presio.storage for one session, as JSON. */
const STORAGE_LIMIT = 16 * 1024;

export class Storage {
  private core: HostCore;

  constructor(core: HostCore) {
    this.core = core;
  }

  readonly methods: MethodTable = {
    "storage.set": {
      handler: (conn, p) => {
        // A local deck's viewer window shares this browser's storage; only
        // the presenter's frames write it (elsewhere it's a quiet no-op, as
        // the same code runs on both).
        if (this.core.ctx.role !== "presenter") return null;
        if (typeof p.key !== "string" || !MESSAGE_TYPE_RE.test(p.key)) {
          throw new HostError("InvalidParams", "A storage key is 1–64 letters, digits or _ . : -");
        }
        const pluginId = conn.plugin.id;
        const next = { ...this.read(pluginId) };
        if (p.value === undefined) delete next[p.key];
        else next[p.key] = p.value;
        if (jsonBytes(next) > STORAGE_LIMIT) {
          throw new HostError("InvalidParams", `presio.storage holds at most ${STORAGE_LIMIT / 1024} KB per plugin`);
        }
        const storeKey = pluginStateKey(this.core.ctx.session.id);
        const all = lsGet<Record<string, unknown>>(storeKey, {});
        lsSet(storeKey, { ...all, [pluginId]: next });
        for (const other of this.core.framesOf(pluginId)) {
          if (other !== conn) this.core.emit(other, "storage.change", { storage: next });
        }
        return null;
      },
    },
  };

  /** A plugin's stored values for this session (the presenter's only). */
  read(pluginId: string): Record<string, unknown> {
    if (this.core.ctx.role !== "presenter") return {};
    const all = lsGet<Record<string, Record<string, unknown>>>(pluginStateKey(this.core.ctx.session.id), {});
    const mine = all?.[pluginId];
    return typeof mine === "object" && mine !== null && !Array.isArray(mine) ? mine : {};
  }
}
