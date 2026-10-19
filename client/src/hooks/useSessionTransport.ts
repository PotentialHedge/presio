// How a presentation window hears about its session: a BroadcastChannel to
// the other windows of this browser, always, and for a synced deck the socket
// to the server as well — joined, kept joined across reconnects, and
// reconciled.

import { useEffect, useRef } from "react";
import type { NavigateFunction, SetURLSearchParams } from "react-router-dom";
import { socket } from "@/lib/socket";
import { startClockSync } from "@/lib/clock";
import { getSessionAuth } from "@/lib/utils";

export interface SessionTransportOptions {
  id: string | undefined;
  /** Whether the deck is local; null while that isn't known yet. */
  local: boolean | null;
  requestedRole: string;
  /** What this window answers a local viewer's state request with (as the controller). */
  stateRef: React.RefObject<{ currentSlide: number; totalSlides: number; blanked: boolean }>;
  setCurrentSlide: React.Dispatch<React.SetStateAction<number>>;
  setTotalSlides: (total: number) => void;
  setBlanked: (blanked: boolean) => void;
  setViewerSlide: (slide: number | null) => void;
  setError: (message: string) => void;
  applyRole: (role: string) => void;
  applyDeckUpdate: (deck: { filename: string; totalSlides: number }) => Promise<void>;
  navigate: NavigateFunction;
  setSearchParams: SetURLSearchParams;
}

/** Subscribes this window to its session; returns the channel to its other windows. */
export function useSessionTransport({
  id,
  local,
  requestedRole,
  stateRef,
  setCurrentSlide,
  setTotalSlides,
  setBlanked,
  setViewerSlide,
  setError,
  applyRole,
  applyDeckUpdate,
  navigate,
  setSearchParams,
}: SessionTransportOptions) {
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (local === null) return; // wait until we know local vs. server

    const channel = new BroadcastChannel(`presio-${id}`);
    channelRef.current = channel;
    channel.onmessage = (e) => {
      const { type, payload } = e.data;
      if (type === "slide_update") setCurrentSlide(payload.slideNumber);
      else if (type === "blank_update") setBlanked(payload.blanked);
      else if (type === "deck_update") void applyDeckUpdate(payload);
      else if (type === "session_ended") navigate("/", { replace: true });
      else if (type === "rekeyed") {
        // The presenter shared this deck from another window. Its local record
        // is gone and the code the server minted is where it lives now, so
        // follow it — the alternative is a viewer left on an id that no longer
        // resolves to anything.
        navigate(`/s/${payload.id}?role=${requestedRole}`, { replace: true });
      }
      else if (type === "state_request") {
        // Controller is the source of truth for a local session; reply so a
        // newly opened or reloaded window can catch up.
        if (requestedRole === "controller") {
          channel.postMessage({ type: "state_sync", payload: stateRef.current });
        }
      } else if (type === "state_sync") {
        setCurrentSlide(payload.currentSlide);
        if (payload.totalSlides) setTotalSlides(payload.totalSlides);
        setBlanked(payload.blanked);
      }
    };

    // Local sessions never touch the server: no socket, sync over the channel.
    if (local) {
      // Subscribing to a transport: the role this window starts with is part
      // of setting that transport up, not something a render can derive.
      applyRole(requestedRole);
      channel.postMessage({ type: "state_request" });
      return () => {
        channel.close();
        channelRef.current = null;
      };
    }

    const { controllerToken } = getSessionAuth(id!);

    // Re-emit join on every (re)connect, not just the first mount. Socket.io
    // transparently reconnects after a network blip, server restart, or a
    // sleeping laptop, but the reconnected socket is in no room and would
    // silently miss every broadcast until it re-joins (looking connected the
    // whole time). The server answers join_session with full session_state, so
    // this also reconciles anything that changed while we were away, and
    // re-registers the controller after a server restart wiped its in-memory map.
    const join = () => {
      socket.emit("join_session", { sessionId: id, role: requestedRole, token: controllerToken });
    };

    socket.on("connect", join);
    socket.connect();
    startClockSync();
    if (socket.connected) join();

    // Re-request authoritative state when a viewer's tab returns to the
    // foreground — background tabs get frozen and can miss broadcasts.
    const reconcile = () => {
      if (requestedRole === "viewer" && !document.hidden && socket.connected) join();
    };
    document.addEventListener("visibilitychange", reconcile);

    // Recovery / reconciliation watchdog. While disconnected, every role nudges
    // the socket to reconnect on a fast 5s cadence so a dropped connection comes
    // back quickly instead of waiting out socket.io's backoff. While connected,
    // viewers re-request state on a slow backstop interval in case a broadcast
    // was ever dropped without a disconnect — kept infrequent and skipped while
    // hidden so a large audience can't hammer the server. The controller is
    // excluded from the backstop: it drives state, so reconciling it from the
    // server could yank it back mid-advance.
    const RECONNECT_EVERY_MS = 5000;
    const RECONCILE_EVERY_MS = 30000;
    let sinceReconcile = 0;
    const watchdog = setInterval(() => {
      if (!socket.connected) {
        socket.connect(); // idempotent; nudges reconnection if it stalled
        sinceReconcile = 0;
        return;
      }
      sinceReconcile += RECONNECT_EVERY_MS;
      if (sinceReconcile >= RECONCILE_EVERY_MS && requestedRole === "viewer" && !document.hidden) {
        sinceReconcile = 0;
        join();
      }
    }, RECONNECT_EVERY_MS);

    socket.on("session_state", ({ currentSlide, totalSlides, role: grantedRole }) => {
      setCurrentSlide(currentSlide);
      setTotalSlides(totalSlides);
      if (grantedRole && grantedRole !== requestedRole) {
        applyRole(grantedRole);
        setSearchParams({ role: grantedRole }, { replace: true });
      } else {
        applyRole(requestedRole);
      }
    });

    socket.on("slide_update", ({ slideNumber }) => {
      setCurrentSlide(slideNumber);
    });

    // The controller corrected the session's page count against the document
    // it loaded; follow suit and stay in range.
    socket.on("total_slides_update", ({ totalSlides }: { totalSlides: number }) => {
      setTotalSlides(totalSlides);
      setCurrentSlide((slide) => Math.min(Math.max(slide, 1), totalSlides));
    });

    socket.on("sync_all", () => {
      setViewerSlide(null);
    });

    socket.on("blank_update", ({ blanked }: { blanked: boolean }) => {
      setBlanked(blanked);
    });

    // The controller replaced the deck (server broadcast from the replace
    // endpoint); reload the new document under the same session. The window
    // that performed the replace has usually applied it already, straight from
    // the reply to its own upload — this then coalesces into that swap.
    socket.on("deck_updated", (payload: { filename: string; totalSlides: number }) => {
      void applyDeckUpdate(payload);
    });

    // Another window took controllership (same token, e.g. a second tab).
    // Demote this one to a viewer — updating the role param re-runs this
    // effect, so the tab rejoins as a viewer and won't grab control back on
    // its next reconnect.
    socket.on("controller_replaced", () => {
      applyRole("viewer");
      setSearchParams({ role: "viewer" }, { replace: true });
    });

    socket.on("error", ({ message }) => {
      setError(message);
    });

    socket.on("session_ended", () => {
      navigate("/", { replace: true });
    });

    return () => {
      channel.close();
      channelRef.current = null;
      document.removeEventListener("visibilitychange", reconcile);
      clearInterval(watchdog);
      socket.off("connect", join);
      socket.off("session_state");
      socket.off("slide_update");
      socket.off("total_slides_update");
      socket.off("sync_all");
      socket.off("blank_update");
      socket.off("deck_updated");
      socket.off("controller_replaced");
      socket.off("error");
      socket.off("session_ended");
      socket.disconnect();
    };
  }, [id, local, requestedRole, navigate, setSearchParams, applyRole, applyDeckUpdate, stateRef, setCurrentSlide, setTotalSlides, setBlanked, setViewerSlide, setError]);

  return channelRef;
}
