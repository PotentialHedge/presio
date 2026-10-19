// The session itself: joining it, and the controller moving through the deck.

import type { Socket } from "socket.io";
import { safeEqual } from "../auth.js";
import { asRecord, isValidSlideNumber, isValidTotalSlides } from "../validation.js";
import { allowJoin, controllerOnly, SESSION_ID_RE } from "./guards.js";
import type { SocketDeps } from "./state.js";
import type { PluginPresence } from "./plugins.js";

export function sessionHandlers({ io, supabase, state }: SocketDeps, presence: PluginPresence) {
  const { controllers, blankedSessions } = state;

  // Tail of each session's in-flight current_slide write, so overlapping
  // updates land in emit order (see slide_change).
  const pendingSlideWrites = new Map<string, Promise<void>>();

  // Slide numbers are validated against each socket's page count, so a
  // change has to reach every socket in the room, not just the sender's.
  const setRoomTotalSlides = async (sessionId: string, totalSlides: number) => {
    for (const s of await io.in(sessionId).fetchSockets()) s.data.totalSlides = totalSlides;
  };

  return (socket: Socket) => {
    socket.on("join_session", async (raw: unknown) => {
      const { sessionId, role, token } = asRecord(raw);
      // Over budget: drop silently. Answering would hand a scanner the timing
      // signal the throttle exists to deny, and a real client simply retries on
      // its next watchdog tick, by which point the bucket has refilled.
      if (!allowJoin(socket)) return;

      // Reject anything that isn't code-shaped without a round trip to the DB.
      if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
        socket.emit("error", { message: "Session not found" });
        return;
      }

      let data;
      try {
        ({ data } = await supabase
          .from("sessions")
          .select("current_slide, total_slides, controller_token")
          .eq("id", sessionId)
          .neq("status", "expired")
          .single());
      } catch (err) {
        console.warn("join_session failed:", err);
        socket.emit("error", { message: "Couldn't join the session" });
        return;
      }

      if (!data) {
        socket.emit("error", { message: "Session not found" });
        return;
      }

      let grantedRole: "controller" | "viewer" = role === "controller" ? "controller" : "viewer";
      if (role === "controller") {
        if (typeof token !== "string" || !safeEqual(token, data.controller_token)) {
          grantedRole = "viewer";
        } else {
          // Last join wins controllership. Tell the socket being displaced
          // (e.g. the controller opened in a second tab) so it can demote
          // itself — otherwise its controls just silently stop working.
          const prev = controllers.get(sessionId);
          if (prev && prev !== socket.id) {
            io.sockets.sockets.get(prev)?.emit("controller_replaced");
          }
          controllers.set(sessionId, socket.id);
        }
      }

      // Moving to another session: it stops running the old one's plugins.
      if (socket.data.sessionId && socket.data.sessionId !== sessionId) presence.set(socket, socket.data.sessionId, new Set());
      socket.join(sessionId);
      socket.data.sessionId = sessionId;
      socket.data.role = grantedRole;
      socket.data.totalSlides = data.total_slides;

      socket.emit("session_state", {
        currentSlide: data.current_slide,
        totalSlides: data.total_slides,
        role: grantedRole,
      });
      socket.emit("plugins_state", presence.pluginsState(sessionId));
      // The controller starts from who's running which plugin (presio.viewers).
      if (grantedRole === "controller") socket.emit("plugin_viewers", { viewers: presence.in(sessionId) });
    });

    socket.on("slide_change", controllerOnly(controllers, socket, async (sessionId, raw: unknown) => {
      const { slideNumber } = asRecord(raw);
      // Reject non-finite/out-of-range values rather than persisting garbage.
      if (!isValidSlideNumber(slideNumber, socket.data.totalSlides)) return;

      // Broadcast before persisting: awaiting the DB first let two rapid
      // changes resolve out of order, leaving viewers (and the stored
      // current_slide) on the older slide until the next navigation.
      io.to(sessionId).emit("slide_update", { slideNumber });

      // Serialize writes per session so the row always ends on the newest
      // slide even when update round-trips overlap.
      const pending = pendingSlideWrites.get(sessionId) ?? Promise.resolve();
      const write = pending
        .then(async () => {
          await supabase
            .from("sessions")
            .update({ current_slide: slideNumber })
            .eq("id", sessionId);
        })
        .catch(() => { /* keep the chain alive */ })
        .then(() => {
          // Drop the entry once this chain has drained so the map doesn't
          // accumulate one promise per session for the process lifetime.
          if (pendingSlideWrites.get(sessionId) === write) pendingSlideWrites.delete(sessionId);
        });
      pendingSlideWrites.set(sessionId, write);
    }));

    socket.on("sync_all", controllerOnly(controllers, socket, (sessionId) => {
      io.to(sessionId).emit("sync_all");
    }));

    // The controller derives the deck's page count from the PDF it actually
    // loaded. A URL-backed deck is re-fetched on every load, so republishing
    // the file with a different page count leaves the stored row stale —
    // correct it here so slide validation and later joins match the document
    // on screen.
    socket.on("total_slides_change", controllerOnly(controllers, socket, async (sessionId, raw: unknown) => {
      const { totalSlides } = asRecord(raw);
      if (!isValidTotalSlides(totalSlides)) return;
      await setRoomTotalSlides(sessionId, totalSlides);
      io.to(sessionId).emit("total_slides_update", { totalSlides });
      const { error } = await supabase.from("sessions").update({ total_slides: totalSlides }).eq("id", sessionId);
      if (error) console.warn(`Couldn't store session ${sessionId}'s page count:`, error.message);
    }));

    socket.on("blank_toggle", controllerOnly(controllers, socket, (sessionId) => {
      if (blankedSessions.has(sessionId)) {
        blankedSessions.delete(sessionId);
      } else {
        blankedSessions.add(sessionId);
      }
      io.to(sessionId).emit("blank_update", { blanked: blankedSessions.has(sessionId) });
    }));

    socket.on("time_ping", (clientT1: number, ack?: (data: { serverTime: number; clientT1: number }) => void) => {
      if (typeof ack === "function") ack({ serverTime: Date.now(), clientT1 });
    });

    socket.on("disconnect", () => {
      const { sessionId } = socket.data;
      if (sessionId && controllers.get(sessionId) === socket.id) {
        controllers.delete(sessionId);
      } else if (sessionId) {
        presence.set(socket, sessionId, new Set());
      }
    });
  };
}
