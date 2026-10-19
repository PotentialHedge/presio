// Plugins in a live session: which run on viewers, their settings, their
// messages (and what's retained for late joiners), and which viewer runs what.

import type { Socket } from "socket.io";
import {
  jsonSize,
  sanitizePluginEvent,
  sanitizePublishedPlugin,
  sanitizePluginSettings,
  sanitizePluginLoadFailure,
  sanitizePluginPresence,
  MAX_PLUGINS_PER_SESSION,
  type PublishedPlugin,
} from "../validation.js";
import { allowAudiencePluginEvent, controllerOnly } from "./guards.js";
import { retainPluginEvent, type SocketDeps } from "./state.js";

/** Who runs which plugin (presio.viewers), and what a joining socket needs to mount them. */
export interface PluginPresence {
  in(sessionId: string): { plugin: string; viewer: string }[];
  set(socket: Socket, sessionId: string, next: Set<string>): void;
  pluginsState(sessionId: string): unknown;
}

export function pluginPresence({ io, state }: SocketDeps): PluginPresence {
  const { controllers, publishedPlugins, pluginRetained, pluginSettings } = state;
  return {
    // Which viewers run which plugins (presio.viewers): each viewer socket keeps
    // the plugins it has frames for in socket.data.plugins, and the controller
    // hears each change. A viewer's id is its socket id, as in `sender`.
    in(sessionId) {
      const viewers: { plugin: string; viewer: string }[] = [];
      for (const id of io.sockets.adapter.rooms.get(sessionId) ?? []) {
        if (controllers.get(sessionId) === id) continue;
        for (const plugin of (io.sockets.sockets.get(id)?.data.plugins as Set<string> | undefined) ?? []) viewers.push({ plugin, viewer: id });
      }
      return viewers;
    },
    set(socket, sessionId, next) {
      const prev: Set<string> = socket.data.plugins ?? new Set();
      socket.data.plugins = next;
      const controller = controllers.get(sessionId);
      if (!controller || controller === socket.id) return;
      for (const plugin of prev) if (!next.has(plugin)) io.to(controller).emit("plugin_viewer", { plugin, viewer: socket.id, here: false });
      for (const plugin of next) if (!prev.has(plugin)) io.to(controller).emit("plugin_viewer", { plugin, viewer: socket.id, here: true });
    },
    // What a joining (or re-joining) socket needs to mount the session's
    // plugins: which ones run and where each loads from (by URL and hash; the
    // viewer fetches them itself), the presenter's settings for each, and the
    // retained messages.
    pluginsState: (sessionId) => ({
      plugins: [...(publishedPlugins.get(sessionId)?.values() ?? [])],
      settings: Object.fromEntries(pluginSettings.get(sessionId) ?? []),
      retained: [...(pluginRetained.get(sessionId)?.values() ?? [])].map(({ plugin, type, payload, retain }) => ({ plugin, type, payload, retain })),
    }),
  };
}

export function pluginHandlers(deps: SocketDeps, presence: PluginPresence) {
  const { io, state } = deps;
  const { controllers, publishedPlugins, pluginSettings } = state;

  return (socket: Socket) => {
    // The controller publishes the plugins that have to run on viewers —
    // where each loads from and its hash, never the plugin itself (viewers
    // fetch that directly) — replacing whatever it published before.
    socket.on("plugins_publish", controllerOnly(controllers, socket, (sessionId, payload: { plugins?: unknown }) => {
      if (!Array.isArray(payload?.plugins)) return;
      const next = new Map<string, PublishedPlugin>();
      for (const raw of payload.plugins.slice(0, MAX_PLUGINS_PER_SESSION)) {
        const plugin = sanitizePublishedPlugin(raw);
        if (plugin) next.set(plugin.id, plugin);
      }
      publishedPlugins.set(sessionId, next);
      io.to(sessionId).emit("plugins_state", presence.pluginsState(sessionId));
    }));

    // The presenter changed a plugin's settings: keep them for joiners and
    // pass them on to the plugin's viewer instances.
    socket.on("plugin_settings", controllerOnly(controllers, socket, (sessionId, raw: unknown) => {
      const update = sanitizePluginSettings(raw);
      if (!update) return;
      const bySession = pluginSettings.get(sessionId) ?? new Map<string, Record<string, unknown>>();
      if (!bySession.has(update.plugin) && bySession.size >= MAX_PLUGINS_PER_SESSION) return;
      bySession.set(update.plugin, update.settings);
      pluginSettings.set(sessionId, bySession);
      socket.to(sessionId).emit("plugin_settings", update);
    }));

    // Plugin messages. The presenter's go to everyone else in the room (and
    // are kept for late joiners when retained); the audience's go to the
    // presenter only, so one phone can't broadcast to the whole room.
    socket.on("plugin_event", (raw: unknown) => {
      const { sessionId } = socket.data;
      if (!sessionId) return;
      const event = sanitizePluginEvent(raw);
      if (!event) return;
      const { plugin, type, payload } = event;

      if (controllers.get(sessionId) === socket.id) {
        // For one viewer: only one in this session.
        if (event.to) {
          if (event.to === socket.id || !io.sockets.adapter.rooms.get(sessionId)?.has(event.to)) return;
          const target = event.volatile ? io.to(event.to).volatile : io.to(event.to);
          target.emit("plugin_event", { plugin, type, payload, from: "presenter" });
          return;
        }
        if (event.retain) retainPluginEvent(state, sessionId, { plugin, type, payload, retain: event.retain, size: jsonSize(payload) });
        // Volatile ones (a laser position) may be dropped for a viewer whose
        // connection is backed up, rather than queued behind newer ones.
        const room = event.volatile ? socket.to(sessionId).volatile : socket.to(sessionId);
        room.emit("plugin_event", { plugin, type, payload, from: "presenter" });
        return;
      }

      // Audience: only to a plugin the presenter actually published.
      if (!publishedPlugins.get(sessionId)?.has(plugin)) return;
      if (!allowAudiencePluginEvent(socket)) return;
      const controller = controllers.get(sessionId);
      if (!controller) return;
      io.to(controller).emit("plugin_event", { plugin, type, payload, from: "audience", sender: socket.id });
    });

    // A viewer's plugins with frames running now (the whole set, re-sent on
    // every join): the controller hears who started or stopped which.
    socket.on("plugin_presence", (raw: unknown) => {
      const { sessionId } = socket.data;
      if (!sessionId || controllers.get(sessionId) === socket.id) return;
      const plugins = sanitizePluginPresence(raw);
      if (!plugins || !allowAudiencePluginEvent(socket)) return;
      // Not checked against what's published: after a restart, viewers say
      // what they run before the presenter has republished.
      presence.set(socket, sessionId, new Set(plugins));
    });

    // A viewer couldn't load one of the published plugins (a presenter's
    // localhost dev server, a version that changed under its URL): tell the
    // presenter, who otherwise can't see it. Throttled like the audience's
    // plugin messages, and only for the version actually published.
    socket.on("plugin_load_failed", (raw: unknown) => {
      const { sessionId } = socket.data;
      if (!sessionId || controllers.get(sessionId) === socket.id) return;
      const failure = sanitizePluginLoadFailure(raw);
      if (!failure) return;
      if (publishedPlugins.get(sessionId)?.get(failure.plugin)?.hash !== failure.hash) return;
      if (!allowAudiencePluginEvent(socket)) return;
      const controller = controllers.get(sessionId);
      if (controller) io.to(controller).emit("plugin_load_failed", { ...failure, sender: socket.id });
    });
  };
}
