// A local deck's plugin transport: a BroadcastChannel between this browser's
// windows (the presenter's and its viewer window). The presenter's window
// orders history edits and holds the audience's slots; the viewer window asks
// it.

import { useEffect } from "react";
import type { AudienceJoin } from "@shared/plugin/audience";
import { audienceViewerId, type PluginHost } from "./host";
import type { HistoryEntry, SyncReply } from "./history";

export function useLocalPluginChannel(host: PluginHost, id: string, local: boolean | null, isPresenter: boolean) {
  useEffect(() => {
    if (local !== true) return;
    const channel = new BroadcastChannel(`presio-plugins-${id}`);
    // A viewer window's address, for presio.viewers and messages `to` it.
    const self = crypto.randomUUID();
    host.setOutbound((event) => channel.postMessage({ kind: "event", event: isPresenter ? event : { ...event, sender: self } }));
    // Which window runs which plugin: each viewer window says, and says
    // nothing runs as it goes.
    if (!isPresenter) host.viewers.setReport((plugins) => channel.postMessage({ kind: "presence", viewer: self, plugins }));
    const leave = () => channel.postMessage({ kind: "presence", viewer: self, plugins: [] });
    if (!isPresenter) window.addEventListener("pagehide", leave);
    // Histories: the presenter's window orders edits and passes each on; the
    // viewer window asks it for what it's missing (blobs it reads itself,
    // from this browser's IndexedDB).
    const syncs = new Map<number, (reply: SyncReply) => void>();
    let nextSync = 1;
    host.history.setLink(
      isPresenter
        ? {
            ordersHere: true,
            publish: (plugin, entry) => channel.postMessage({ kind: "history_entry", plugin, entry }),
            reset: (plugin) => channel.postMessage({ kind: "history_reset", plugin }),
            loaded: (plugin) => channel.postMessage({ kind: "history_reset", plugin }),
          }
        : {
            sync: (plugin, head) =>
              new Promise<SyncReply>((resolve, reject) => {
                const reqId = nextSync++;
                const timer = setTimeout(() => {
                  syncs.delete(reqId);
                  reject(new Error("the presenter's window didn't answer"));
                }, 5000);
                syncs.set(reqId, (reply) => {
                  clearTimeout(timer);
                  syncs.delete(reqId);
                  resolve(reply);
                });
                channel.postMessage({ kind: "history_sync", reqId, plugin, head });
              }),
          },
      true
    );
    // Audience input: the viewer window is the audience, and this browser's
    // presenter window holds the slots.
    const viewer = audienceViewerId(id);
    const audienceReplies = new Map<string, (error: string | null) => void>();
    host.audience.setLink(
      isPresenter
        ? {
            open: async (plugin, key) => channel.postMessage({ kind: "audience_state", plugin, key, open: true }),
            close: async (plugin, key) => channel.postMessage({ kind: "audience_state", plugin, key, open: false }),
            clear: async (plugin, key) => channel.postMessage({ kind: "audience_cleared", plugin, key }),
          }
        : {
            set: (plugin, key, value) =>
              new Promise<void>((resolve, reject) => {
                const reqId = `${viewer}:${nextSync++}`;
                const timer = setTimeout(() => {
                  audienceReplies.delete(reqId);
                  reject(new Error("The presenter's window didn't answer"));
                }, 5000);
                audienceReplies.set(reqId, (error) => {
                  clearTimeout(timer);
                  audienceReplies.delete(reqId);
                  if (error) reject(new Error(error));
                  else resolve();
                });
                channel.postMessage({ kind: "audience_set", reqId, plugin, key, value, viewer });
              }),
          }
    );
    const onAudience = (m: Record<string, unknown>) => {
      const { kind, plugin, key } = m as { kind: string; plugin: string; key: string };
      if (isPresenter) {
        if (kind === "audience_join") {
          channel.postMessage({ kind: "audience_join_reply", viewer: m.viewer, join: host.audience.joinFor(String(m.viewer)) });
        } else if (kind === "audience_set") {
          const error = host.audience.receiveWrite(plugin, key, String(m.viewer), m.value);
          channel.postMessage({ kind: "audience_set_reply", reqId: m.reqId, error });
        }
        return;
      }
      if (kind === "audience_state") host.audience.receiveKeyState(plugin, key, m.open === true);
      else if (kind === "audience_cleared") host.audience.receiveCleared(plugin, key);
      else if (kind === "audience_join_reply" && m.viewer === viewer) host.audience.receiveJoin(m.join as AudienceJoin);
      else if (kind === "audience_set_reply") audienceReplies.get(String(m.reqId))?.((m.error as string | null) ?? null);
      else if (kind === "audience_resync") channel.postMessage({ kind: "audience_join", viewer });
    };

    channel.onmessage = (e) => {
      const { kind, event, events, plugin, entry, head, reqId, reply } = e.data ?? {};
      if (typeof kind === "string" && kind.startsWith("audience_")) onAudience(e.data);
      else if (kind === "event") {
        if (!event?.to || event.to === self) host.receive(event);
      } else if (kind === "presence" && isPresenter) host.viewers.setFor(String(e.data.viewer), Array.isArray(e.data.plugins) ? e.data.plugins : []);
      else if (kind === "viewers_resync" && !isPresenter) host.viewers.resend();
      else if (kind === "retained") host.seedRetained(events);
      else if (kind === "hello" && isPresenter) channel.postMessage({ kind: "retained", events: host.retainedEvents() });
      else if (kind === "history_entry" && !isPresenter) host.history.receive(plugin, entry as HistoryEntry);
      else if (kind === "history_reset" && !isPresenter) host.history.receiveReset(plugin);
      else if (kind === "history_sync" && isPresenter) {
        channel.postMessage({ kind: "history_sync_reply", reqId, reply: host.history.answerSync(plugin, head) });
      } else if (kind === "history_sync_reply" && !isPresenter) syncs.get(reqId)?.(reply);
    };
    if (!isPresenter) {
      channel.postMessage({ kind: "hello" });
      channel.postMessage({ kind: "audience_join", viewer });
    } else {
      // A viewer window opened before this one: it asks again.
      channel.postMessage({ kind: "audience_resync" });
      channel.postMessage({ kind: "viewers_resync" });
    }
    return () => {
      if (!isPresenter) {
        window.removeEventListener("pagehide", leave);
        leave();
      }
      host.viewers.setReport(null);
      channel.close();
      host.setOutbound(() => {});
      host.history.setLink({}, false);
      host.audience.setLink(null);
    };
  }, [host, id, local, isPresenter]);
}
