import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useSearchParams, useNavigate, useLocation, Link } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdf, loadPdfData, freshPdfUrl, loadLatestPdf, renderPage, clearCache, openPdf, destroyPdf } from "@/lib/pdf";
import { loadDeck, type Deck } from "@/lib/deck";
import { useRenderTargetWidth } from "@/hooks/useRenderTargetWidth";
import { useElementRef } from "@/hooks/useElementRef";
import { lsGetString, lsSetString, lsRemove, deckWatchKey, slideKey } from "@/lib/storage";
import { socket } from "@/lib/socket";
import { useLatestRef } from "@/hooks/useLatestRef";
import { startClockSync } from "@/lib/clock";
import { supabase } from "@/lib/supabaseClient";
import { authEnabled } from "@/lib/authMode";
import { getSessionAuth, endSession } from "@/lib/utils";
import { idbGet, idbPut, idbDelete } from "@/lib/localStore";
import { isLocalDeckId } from "@/lib/localId";
import {
  DeckWatcher,
  isDeckWatchSupported,
  isDeckWatchMode,
  type DeckWatchMode,
  type DeckWatchStatus,
} from "@/lib/deckWatcher";
import { ConfirmDeckReloadDialog } from "@/components/controller/ConfirmDeckReloadDialog";
import { track, sha256Hex } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { usePluginHost } from "@/lib/plugins/usePluginHost";
import { ControllerView } from "./ControllerView";
import { ViewerView } from "./ViewerView";

export default function Presentation() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // Set by Home when it navigates here right after replacing this deck's PDF
  // (see the initial load below). A timestamp, not a flag, so the cache-busted
  // URL is stable across reloads of this page.
  const replacedAt = (useLocation().state as { deckReplaced?: number } | null)?.deckReplaced;
  const requestedRole = searchParams.get("role") || "viewer";
  const [role, setRole] = useState(requestedRole);
  // The role once the session actually settles it — null while the request is
  // still in flight, since the server can hand back something other than what
  // the URL asked for. Only this drives analytics, never `requestedRole`.
  const [settledRole, setSettledRole] = useState<string | null>(null);
  const applyRole = useCallback((next: string) => {
    setRole(next);
    setSettledRole(next);
  }, []);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [currentSlide, setCurrentSlide] = useState(1);
  const [viewerSlide, setViewerSlide] = useState<number | null>(null);
  const [totalSlides, setTotalSlides] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [blanked, setBlanked] = useState(false);

  // Everything extracted from the loaded PDF (links, attachments…),
  // re-derived whenever the document is swapped (e.g. after a notes edit).
  const [deck, setDeck] = useState<Deck | null>(null);
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    loadDeck(pdf, pdfUrl, filename).then((loaded) => {
      if (!cancelled) setDeck(loaded);
    });
    return () => { cancelled = true; };
  }, [pdf, pdfUrl, filename]);

  // The current slide's container, which a dashboard layout change replaces:
  // rendering follows the element, not just the ref.
  const [currentCanvasRef, currentCanvasEl] = useElementRef<HTMLDivElement>();
  const channelRef = useRef<BroadcastChannel | null>(null);
  // Object URL backing a local session's PDF, swapped when notes are edited.
  const localUrlRef = useRef("");
  // Resolved during load: true if this presentation's PDF lives in this
  // browser's IndexedDB (local session). null until known.
  const [local, setLocal] = useState<boolean | null>(null);

  const isViewer = role === "viewer";
  const outOfSync = isViewer && viewerSlide !== null;
  const displaySlide = outOfSync ? viewerSlide! : currentSlide;

  const plugins = usePluginHost({
    id: id!,
    local,
    isPresenter: role === "controller",
    pdf,
    currentSlide: displaySlide,
    totalSlides,
  });

  // Latest broadcastable state, for replying to a local window's state_request
  // without re-subscribing the channel on every slide change.
  const stateRef = useLatestRef({
    currentSlide,
    totalSlides,
    blanked,
  });

  // Mirror of pdfUrl for callbacks that must not re-subscribe the socket
  // effect when it changes (a deck replace rewrites it on local sessions).
  const pdfUrlRef = useLatestRef(pdfUrl);

  // Deck file watching (File System Access API, Chromium only). When the
  // IndexedDB record carries a handle to the deck's file on disk, the
  // controller polls it and offers a recompile through the header pill —
  // nothing swaps until the presenter clicks. Viewers don't watch: the
  // controller applies the update on everyone's behalf.
  const [deckWatchStatus, setDeckWatchStatus] = useState<DeckWatchStatus | null>(null);
  const watcherRef = useRef<DeckWatcher | null>(null);
  const applyingWatchRef = useRef(false);
  // Auto mode applies from inside the watcher's callback, which captured an
  // older closure; a ref keeps that path on the current applyDeckWatchUpdate.
  const applyDeckWatchUpdateRef = useRef<() => Promise<void>>(async () => {});
  // Bumped when a replace stores a new file handle, so the effect below tears
  // the watcher down and re-reads the record — otherwise watching would stay
  // pinned to the previous file until a reload.
  const [watchedHandleEpoch, setWatchedHandleEpoch] = useState(0);
  // Whether this deck carries a watchable file handle. Until that's known the
  // header shows no live-reload control at all rather than a wrong one.
  // Whether this deck's IndexedDB record carries a handle to a file on disk.
  // Resolved by the watcher effect below; whether that handle is any use right
  // now is a separate, derivable question (see deckWatchable).
  const [deckHasHandle, setDeckHasHandle] = useState(false);
  // How the presenter wants recompiles handled. Chosen at upload (Home's
  // live-reload checkbox), changed from the header, and remembered per deck.
  const [deckWatchMode, setDeckWatchMode] = useState<DeckWatchMode>(() => {
    const stored = lsGetString(deckWatchKey(id!));
    return isDeckWatchMode(stored) ? stored : "prompt";
  });
  const deckWatchModeRef = useLatestRef(deckWatchMode);
  // A detected deck change waiting on the presenter: "watch" from the file
  // watcher (prompt mode only), "remote" from the URL-republish poller. Both
  // replace the deck (dropping edits saved into it here, and what plugins
  // hung off its slides), so both get the same warning.
  const [reloadPrompt, setReloadPrompt] = useState<"watch" | "remote" | null>(null);
  const [applyingWatch, setApplyingWatch] = useState(false);
  // Edits a plugin saved into the deck (e.g. speaker notes) live in the
  // current PDF's bytes, so a recompiled file replaces them. Tracked to warn
  // before that happens.
  const [deckEdited, setDeckEdited] = useState(false);

  // A URL-backed deck's source PDF was republished (remote-version polling
  // below); held until the presenter applies it or the poller replaces it
  // with a newer sighting. Null = nothing pending.
  const [remoteUpdate, setRemoteUpdate] = useState<{ totalSlides: number } | null>(null);
  // Whether pdfUrl points at someone else's host (a URL-backed deck) rather
  // than our own storage. Decides how a changed deck is re-fetched.
  const [externalPdf, setExternalPdf] = useState(false);
  const externalPdfRef = useLatestRef(externalPdf);
  // The republished deck, already downloaded and parsed by the poller to
  // confirm it. Handed to applyDeckUpdate so applying costs no second download.
  const prefetchedDeckRef = useRef<PDFDocumentProxy | null>(null);

  // The settled role, not the requested one: a second controller demoted to
  // viewer by session_state must stop watching too.
  const canWatchDeck = !!local && role === "controller" && isDeckWatchSupported();
  const deckWatchable = canWatchDeck && deckHasHandle;

  useEffect(() => {
    if (!canWatchDeck) return;
    let cancelled = false;
    idbGet(id!)
      .then((rec) => {
        if (cancelled || !rec?.handle) return;
        // The control appears as soon as there's a file to watch, whatever the
        // mode — that's what makes "live reload off" a state you can leave.
        setDeckHasHandle(true);
        if (deckWatchModeRef.current === "off") return;
        const watcher = new DeckWatcher(rec.handle, {
          onStatus: (status) => {
            if (!cancelled) setDeckWatchStatus(status);
          },
          // Signal only — the File seen at detection is re-read at apply time.
          onUpdate: () => {
            if (cancelled) return;
            setDeckWatchStatus("updated");
            // Auto mode swaps without asking; prompt mode puts the decision
            // (and what it costs) in front of the presenter first.
            if (deckWatchModeRef.current === "auto") void applyDeckWatchUpdateRef.current();
            else setReloadPrompt("watch");
          },
        });
        watcherRef.current = watcher;
        void watcher.begin().catch(() => {
          // Unexpected permission-check failure: offer the explicit resume.
          if (!cancelled) setDeckWatchStatus("needs-permission");
        });
      })
      .catch(() => { /* no record, no watcher */ });
    return () => {
      cancelled = true;
      watcherRef.current?.stop();
      watcherRef.current = null;
      setDeckWatchStatus(null);
      setReloadPrompt((p) => (p === "watch" ? null : p));
    };
  }, [canWatchDeck, id, watchedHandleEpoch, deckWatchMode, deckWatchModeRef]);

  // A local deck's controller keeps its slide across a reload.
  useEffect(() => {
    if (local && role === "controller") lsSetString(slideKey(id!), String(currentSlide));
  }, [currentSlide, local, role, id]);

  // Persist the live-reload choice per deck, so it survives a reload.
  useEffect(() => {
    if (local && role === "controller") lsSetString(deckWatchKey(id!), deckWatchMode);
  }, [deckWatchMode, local, role, id]);

  // Picked from the header's live-reload menu. The effect above persists it,
  // so a mode chosen here survives a controller reload.
  const chooseDeckWatchMode = useCallback((mode: DeckWatchMode) => {
    setDeckWatchMode(mode);
  }, []);

  // The deck swap currently being loaded, if any. A replacement uploaded from
  // this window is announced to it twice — by the upload's own response and by
  // the server's `deck_updated` broadcast, the one every viewer acts on — and
  // both describe the same document. Keyed on that description so whichever
  // announcement lands first starts the swap and the other joins it rather
  // than downloading the same deck a second time. Cleared once the swap
  // settles, so a later announcement is never mistaken for this one.
  const deckSwapRef = useRef<{ key: string; done: Promise<void> } | null>(null);

  // Swap in a replacement deck: announced over the wire (socket `deck_updated`
  // for synced sessions, a BroadcastChannel `deck_update` for local ones) or by
  // the reply to this window's own replace. What plugins retained for the old
  // deck (retain: "deck" — drawings, keyed by slide number, which the new
  // document may renumber) is dropped wholesale, and they hear it's a new
  // document. Slide clamping needs no extra work here: the deck effect
  // adopts the new document's page count once it loads.
  const applyDeckUpdate = useCallback(
    ({ filename, totalSlides }: { filename: string; totalSlides: number }): Promise<void> => {
      const key = `${totalSlides}:${filename}`;
      const inFlight = deckSwapRef.current;
      if (inFlight?.key === key) return inFlight.done;

      setFilename(filename);
      plugins.host.forgetDeckRetained();
      // Whatever was saved into the deck here lived in the outgoing PDF's bytes.
      setDeckEdited(false);
      setTotalSlides(totalSlides);
      setCurrentSlide((slide) => Math.min(Math.max(slide, 1), totalSlides));
      const done = (async () => {
        try {
          if (local) {
            // Same-browser windows read the fresh record straight from IndexedDB.
            const rec = await idbGet(id!);
            if (!rec) return;
            const bytes = new Uint8Array(await rec.blob.arrayBuffer());
            const doc = await loadPdfData(bytes);
            setPdf(doc);
            const url = URL.createObjectURL(rec.blob);
            if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
            localUrlRef.current = url;
            setPdfUrl(url);
          } else {
            clearCache();
            // The remote-version poller already downloaded and parsed the
            // republished deck to confirm it. When this update is that one,
            // adopt the document it has rather than fetching the same bytes
            // again mid-presentation.
            const prefetched = prefetchedDeckRef.current;
            prefetchedDeckRef.current = null;
            if (prefetched && prefetched.numPages === totalSlides) {
              setPdf(prefetched);
              return;
            }
            destroyPdf(prefetched);
            const doc = await loadLatestPdf(pdfUrlRef.current, {
              external: externalPdfRef.current,
              version: Date.now(),
            });
            setPdf(doc);
          }
        } catch {
          // Keep showing the previous deck rather than a broken screen; the
          // stored row already describes the new one and a reload recovers.
        }
      })();
      deckSwapRef.current = { key, done };
      void done.finally(() => {
        if (deckSwapRef.current?.done === done) deckSwapRef.current = null;
      });
      return done;
    },
    [local, id, externalPdfRef, pdfUrlRef, plugins.host]
  );

  useEffect(() => {
    let cancelled = false;
    let localUrl = "";
    (async () => {
      try {
        // If the PDF is in this browser's IndexedDB, it's a local session —
        // render it without the server (works offline, independent of the row).
        const rec = await idbGet(id!).catch(() => {
          throw new Error("Couldn't read the presentation from this browser. Private/incognito mode isn't supported — please use a normal window.");
        });
        if (rec) {
          if (cancelled) return;
          setLocal(true);
          // Back on the slide it was on. Restored with `local`, before the
          // effect that saves it can see this deck on slide 1.
          setCurrentSlide(Math.min(Math.max(Number(lsGetString(slideKey(id!))) || 1, 1), rec.totalSlides));
          localUrl = URL.createObjectURL(rec.blob);
          localUrlRef.current = localUrl;
          const doc = await loadPdf(localUrl);
          if (cancelled) return;
          setPdfUrl(localUrl);
          setPdf(doc);
          setFilename(rec.filename);
          setTotalSlides(rec.totalSlides);
          return;
        }

        // A browser-local deck has no server row, so an id of that shape with
        // no record means the deck isn't here — not that the server might know
        // better. Say so instead of waiting out a lookup that can't succeed
        // (and, offline, can't even be attempted).
        if (isLocalDeckId(id!)) {
          throw new Error("This presentation is only available in the same browser on the device it was created on");
        }
        const res = await fetch(`/api/sessions/${id}`);
        if (!res.ok) throw new Error("Session not found");
        const session = await res.json();
        if (session.local) {
          // Server knows this code, but the PDF only lives on the presenter's device.
          throw new Error("This presentation is only available in the same browser on the device it was created on");
        }
        if (cancelled) return;
        setLocal(false);
        setExternalPdf(!!session.external);
        // Arriving straight from a replace (Home's recents/re-upload flow) the
        // stored object has new bytes at the same URL, and this browser is the
        // one most likely to have the old copy cached — it had the deck open
        // before. Viewers already in the room don't hit this: they get
        // deck_updated and reload through applyDeckUpdate, which busts too.
        // Keyed by the replace's own timestamp, so a reload of this page reuses
        // the fetch rather than starting another one.
        const doc = await loadPdf(
          replacedAt ? freshPdfUrl(session.pdfUrl, replacedAt) : session.pdfUrl
        );
        if (cancelled) return;
        // Store the canonical URL: later reloads append their own version.
        setPdfUrl(session.pdfUrl);
        setPdf(doc);
        setFilename(session.filename);
        setTotalSlides(session.total_slides);
        setCurrentSlide(session.current_slide);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load presentation");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      clearCache();
      if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
    };
    // replacedAt belongs here: replacing the same deck again from Home routes
    // back to this already-mounted page with a new timestamp, and that has to
    // reload the document rather than leave the previous one on screen.
  }, [id, replacedAt]);

  // The loaded document decides the page count: URL-backed decks re-fetch
  // their PDF on every load, so a republished file can change the page count
  // under a value stored at creation time. Adopt the document's count, pull
  // the current slide back into range, and refresh whatever stored count
  // remains (IndexedDB record / session row) so every device agrees.
  useEffect(() => {
    if (!deck) return;
    const docTotal = deck.totalSlides;
    if (totalSlides === docTotal) return;
    // Reconciling with the document itself, which only exists once it has
    // finished loading — there is no render-time value to derive this from.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTotalSlides(docTotal);
    setCurrentSlide((slide) => Math.min(Math.max(slide, 1), docTotal));
    if (local) {
      idbGet(id!).then((rec) => {
        if (rec && rec.totalSlides !== docTotal) idbPut({ ...rec, totalSlides: docTotal });
      }).catch(() => { /* best effort */ });
    } else if (role === "controller") {
      // Only the controller can correct the stored row; viewers already show
      // the document-derived count either way.
      socket.emit("total_slides_change", { totalSlides: docTotal });
    }
  }, [deck, totalSlides, local, role, id]);

  useEffect(() => {
    if (!filename) return;
    const suffix = role === "controller" ? "Controller" : "Viewer";
    document.title = `${filename} - ${suffix}`;
    return () => { document.title = "Presio"; };
  }, [filename, role]);

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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
  }, [id, local, requestedRole, navigate, setSearchParams, applyRole, applyDeckUpdate, stateRef]);

  // Report the settled role to analytics. The `?role=` query param is already
  // in every tracked URL, but Umami's Pages report keys on the path alone, so
  // viewers and controllers collapse into one `/s/:id` row. A custom event
  // gives them their own breakdown. Fires once per role: reconnects re-settle
  // the same value, and only a real change (a controller demoted by
  // controller_replaced) counts as a second data point.
  const trackedRoleRef = useRef("");
  useEffect(() => {
    if (!settledRole) return;
    if (trackedRoleRef.current === settledRole) return;
    trackedRoleRef.current = settledRole;
    track("session-role", { role: settledRole, mode: local ? "local" : "server" });
  }, [settledRole, local]);

  // The canvas is rendered at the container's pixel size, so anything that
  // changes that size or scale — entering fullscreen, dragging the viewer onto
  // a projector, browser zoom, a move to a differently scaled monitor — has to
  // re-render, or the slide stays an upscaled canvas from the old size.
  const viewWidth = useRenderTargetWidth(currentCanvasEl, !!deck);

  useEffect(() => {
    if (!pdf || !currentCanvasEl || !viewWidth) return;
    const container = currentCanvasEl;
    // renderPage resolves out of order (cached pages are near-instant, fresh
    // ones aren't), so a rapid slide change could leave a stale page on screen
    // — with plugins' layers already showing the new slide over it. Drop any
    // render that finishes after the effect has moved on.
    let stale = false;
    renderPage(pdf, displaySlide, { targetWidth: viewWidth }).then((canvas) => {
      if (stale) return;
      container.innerHTML = "";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.objectFit = "contain";
      container.appendChild(canvas);
    });
    return () => { stale = true; };
    // The container comes and goes with the view (and card) that owns it:
    // render into whichever one is mounted now.
  }, [pdf, displaySlide, currentCanvasEl, viewWidth]);

  // Mirror a local state change outward: always to other same-browser windows
  // (BroadcastChannel) and, for synced sessions, to the server (socket). The
  // channel message `type` and the socket `event` intentionally differ — the
  // server echoes a *_update broadcast in response to a *_change/control emit.
  const broadcast = useCallback(
    (
      channelMsg: { type: string; payload?: unknown },
      socketEmit?: { event: string; payload?: unknown }
    ) => {
      if (!local && socketEmit) socket.emit(socketEmit.event, socketEmit.payload);
      channelRef.current?.postMessage(channelMsg);
    },
    [local]
  );

  const goTo = useCallback(
    (slide: number) => {
      if (slide < 1 || slide > totalSlides) return;
      broadcast(
        { type: "slide_update", payload: { slideNumber: slide } },
        { event: "slide_change", payload: { slideNumber: slide } }
      );
      setCurrentSlide(slide);
    },
    [totalSlides, broadcast]
  );

  const viewerGoTo = useCallback(
    (slide: number) => {
      // Local viewers always follow the controller — no independent navigation.
      if (local) return;
      if (slide < 1 || slide > totalSlides) return;
      setViewerSlide(slide);
    },
    [totalSlides, local]
  );

  const resync = useCallback(() => setViewerSlide(null), []);

  const syncAll = useCallback(() => { if (!local) socket.emit("sync_all"); }, [local]);

  const endPresentation = useCallback(async () => {
    if (local) {
      await idbDelete(id!).catch(() => { /* ignore */ });
      lsRemove(slideKey(id!));
      channelRef.current?.postMessage({ type: "session_ended" });
    } else {
      await endSession(id!);
    }
    navigate("/", { replace: true });
  }, [local, id, navigate]);

  // Authorization for rewriting a synced deck's stored PDF. The server accepts
  // either the presentation's controller token or the logged-in owner's bearer
  // token, so send whichever this browser has — and both when it has both.
  //
  // Sending only the bearer token used to be enough for the common case and
  // wrong for one that matters: a signed-in presenter who took control by
  // passphrase isn't the owner, so their token doesn't authorize the write and
  // the controller token that would was never sent.
  const pdfWriteAuth = useCallback(async (): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {};
    const { controllerToken } = getSessionAuth(id!);
    if (controllerToken) headers["x-controller-token"] = controllerToken;
    if (authEnabled) {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    }
    if (!Object.keys(headers).length) {
      throw new Error("This browser isn't the controller for this presentation");
    }
    return headers;
  }, [id]);

  // Remote republish watching for URL-backed decks. A deck loaded from an
  // external link re-fetches its PDF on every load, so a republish at the
  // same URL is only invisible to a session that is already running. The
  // controller polls the server's cheap metadata endpoint (one poller per
  // session — viewers never poll) and, when the remote file provably changed,
  // offers the new deck through the header pill. Same house rule as the file
  // watcher: nothing swaps until the presenter clicks, and nothing surfaces
  // when the host is unreachable or doesn't support the check.
  useEffect(() => {
    if (local !== false || role !== "controller") return;
    const base = pdfUrlRef.current;
    if (!base || base.startsWith("blob:")) return;

    const BASE_MS = 30_000;
    const MAX_MS = 4 * 60_000;
    interface Sig {
      etag: string;
      lastModified: string;
      contentLength: string;
    }
    const same = (a: Sig, b: Sig) =>
      a.etag === b.etag && a.lastModified === b.lastModified && a.contentLength === b.contentLength;
    const hasValidators = (s: Sig) => !!(s.etag || s.lastModified || s.contentLength);

    let stopped = false;
    let busy = false; // a poll's probes + parse can outlast one interval; never overlap
    let backedOff = false; // parked at the slow cadence by an unreachable host
    let delay = BASE_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let baseline: Sig | null = null;
    let candidate: Sig | null = null;

    const stop = () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => { void poll(); }, delay);
    };

    const poll = async () => {
      if (stopped || busy) return;
      // Frozen background tabs can't present anyway; skip the round without
      // spending a request on the remote host.
      if (document.hidden) {
        schedule();
        return;
      }
      busy = true;
      try {
        let headers: Record<string, string>;
        try {
          headers = await pdfWriteAuth();
        } catch {
          stop(); // no credential to poll with — degrade silently
          return;
        }
        let sig: Sig;
        try {
          const res = await fetch(`/api/sessions/${id}/remote-version`, { headers });
          if (res.status === 403 || res.status === 404) {
            stop(); // session gone, or not URL-backed: nothing to watch
            return;
          }
          if (!res.ok) {
            // Remote host unreachable (the server answers 502): back off to
            // the slowest cadence and keep trying, still silently.
            delay = MAX_MS;
            backedOff = true;
            schedule();
            return;
          }
          sig = await res.json();
          if (backedOff) {
            // The host answered again. Without this the session stays parked at
            // the four-minute cadence for good, since only a confirmed change
            // resets it — and it can't see one while the host is down.
            backedOff = false;
            delay = BASE_MS;
          }
        } catch {
          stop(); // network failure — today's behaviour, without errors
          return;
        }
        if (!hasValidators(sig)) {
          stop(); // host sends no validators — there is nothing to compare
          return;
        }
        if (!baseline) {
          baseline = sig; // first observation is the reference, never a change
          schedule();
          return;
        }
        if (same(sig, baseline)) {
          candidate = null;
          delay = Math.min(delay * 2, MAX_MS); // polite backoff while unchanged
          schedule();
          return;
        }
        // Different from the baseline. Hosts behind some CDNs mint a fresh
        // ETag per request, so require the new signature to hold steady
        // across two consecutive polls before trusting it.
        if (!candidate || !same(sig, candidate)) {
          candidate = sig;
          schedule();
          return;
        }
        // Confirmed change: read the new document's page count before
        // offering it, so applying clamps correctly. A parse failure means
        // the publish is probably mid-flight — keep watching silently and
        // re-detect on the next poll.
        candidate = null;
        try {
          // Always external here: the server only answers remote-version for a
          // deck backed by someone else's URL.
          const doc = await loadLatestPdf(base, { external: true, version: Date.now() });
          if (stopped) {
            destroyPdf(doc);
            return;
          }
          // Keep it: if the presenter applies this update, applyDeckUpdate
          // adopts the document instead of downloading the same bytes again.
          destroyPdf(prefetchedDeckRef.current);
          prefetchedDeckRef.current = doc;
          baseline = sig;
          delay = BASE_MS; // stay fast for a while after a real change
          setRemoteUpdate({ totalSlides: doc.numPages });
          setReloadPrompt("remote");
        } catch {
          // candidate stays null: the next poll re-confirms and retries.
        }
        schedule();
      } finally {
        busy = false;
      }
    };

    schedule();
    return () => {
      stop();
      destroyPdf(prefetchedDeckRef.current);
      prefetchedDeckRef.current = null;
    };
  }, [local, role, id, pdfUrl, pdfWriteAuth, pdfUrlRef]);

  // Pill click: announce the republished deck for controller and viewers via
  // the server's deck_updated broadcast — every client (this one included)
  // cache-busts the URL and reloads through the ordinary deck_updated path.
  const applyRemoteDeckUpdate = useCallback(async () => {
    if (!remoteUpdate || applyingWatch) return;
    setApplyingWatch(true);
    try {
      const authHeaders = await pdfWriteAuth();
      const res = await fetch(`/api/sessions/${id}/deck-refreshed`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ total_slides: remoteUpdate.totalSlides }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to apply the updated deck");
      }
      setRemoteUpdate(null);
      setReloadPrompt(null);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to apply the updated deck");
    } finally {
      setApplyingWatch(false);
    }
  }, [remoteUpdate, applyingWatch, id, pdfWriteAuth]);

  // Save an edited PDF over the deck (a plugin's presio.deck.save), then swap
  // in the updated document so further edits build on it. Local sessions
  // update IndexedDB; synced ones re-upload to the owner's stored PDF. Only
  // edits in place: a different page count is a replace, not an edit.
  const saveDeck = useCallback(
    async (updated: Uint8Array) => {
      if (!pdf) throw new Error("The deck hasn't loaded yet");
      // A copy: pdf.js transfers what it's given to its worker, detaching it.
      const doc = await loadPdfData(updated.slice()).catch(() => {
        throw new Error("That isn't a PDF Presio can open");
      });
      if (doc.numPages !== pdf.numPages) {
        throw new Error("An edited deck must keep the same slides");
      }
      // Coerce to a plain ArrayBuffer slice so Blob's BlobPart typing is happy.
      const buf = updated.buffer.slice(
        updated.byteOffset,
        updated.byteOffset + updated.byteLength
      ) as ArrayBuffer;
      const blob = new Blob([buf], { type: "application/pdf" });

      if (local) {
        const rec = await idbGet(id!);
        if (rec) await idbPut({ ...rec, blob });
      } else {
        // Synced deck: re-upload to its server copy.
        const authHeaders = await pdfWriteAuth();
        const form = new FormData();
        form.append("pdf", blob, `${filename || "presentation"}.pdf`);
        const res = await fetch(`/api/sessions/${id}/pdf`, {
          method: "POST",
          headers: authHeaders,
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to save the deck");
        }
      }

      // These edits live in this PDF's bytes, so a recompiled file would drop
      // them. Remembered so the live-reload prompt can say so.
      setDeckEdited(true);

      // Same pages, edited: plugins keep what they hang off them.
      plugins.host.expectDeckEdit();
      setPdf(doc);
      if (local) {
        const url = URL.createObjectURL(blob);
        if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
        localUrlRef.current = url;
        setPdfUrl(url);
      }
    },
    [pdf, local, id, filename, pdfWriteAuth, plugins.host]
  );
  useEffect(() => {
    plugins.host.setDeckWriter(role === "controller" ? saveDeck : null);
  }, [plugins.host, role, saveDeck]);

  // Replace this presentation's PDF with a new file, keeping the session id,
  // code, controller token and passphrase. Mirrors saveNotes' local/synced
  // fork: local decks swap the IndexedDB record in place (nothing uploads);
  // synced ones re-upload to their stored object and let the server's
  // deck_updated broadcast drive the document swap on every client.
  const replacePdf = useCallback(
    async (file: File, handle?: FileSystemFileHandle) => {
      if (local === null) return;
      const buf = await file.arrayBuffer();
      // Snapshot before pdf.js transfers the buffer away (see Home.upload).
      const blob = new Blob([buf], { type: "application/pdf" });
      let sha256: string | undefined;
      try {
        sha256 = await sha256Hex(buf);
      } catch {
        // No crypto.subtle (plain-http origins): track without a fingerprint.
      }
      const doc = await openPdf({ data: new Uint8Array(buf) });
      const totalSlides = doc.numPages;
      destroyPdf(doc);
      const filename = file.name.replace(/\.pdf$/i, "");

      if (local) {
        const rec = await idbGet(id!);
        if (!rec) throw new Error("This presentation is no longer in this browser");
        // A handle passed along (picked via showOpenFilePicker or read from
        // the watched file itself) replaces the stored one, so watching
        // follows the new file; without one the existing handle stays.
        await idbPut({ ...rec, blob, filename, totalSlides, sha256, ...(handle ? { handle } : {}) });
        channelRef.current?.postMessage({
          type: "deck_update",
          payload: { filename, totalSlides },
        });
        await applyDeckUpdate({ filename, totalSlides });
      } else {
        const authHeaders = await pdfWriteAuth();
        const form = new FormData();
        form.append("pdf", blob, `${filename}.pdf`);
        form.append("filename", filename);
        const res = await fetch(`/api/sessions/${id}/pdf`, {
          method: "POST",
          headers: authHeaders,
          body: form,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || "Failed to replace the PDF");
        }
        // Swap the new deck in from this reply rather than waiting for the
        // server's `deck_updated` broadcast to come back around to us. That
        // broadcast is what moves the viewers, and it usually moves this
        // window too — but it is a single fire-and-forget message to the one
        // socket that just spent the upload saturating its connection, and a
        // missed one has no recovery: nothing re-announces a deck, so the
        // presenter stayed on the old slides until a manual reload while every
        // viewer had already moved on. Applying here needs no socket at all,
        // and the broadcast, when it does arrive, joins this same swap.
        await applyDeckUpdate({
          // The server's spelling of both, so the broadcast describing this
          // replace produces the identical key and coalesces with it.
          filename: typeof body.filename === "string" && body.filename ? body.filename : filename,
          totalSlides: typeof body.totalSlides === "number" ? body.totalSlides : totalSlides,
        });
      }

      track("deck-replace", {
        filename,
        sha256,
        size: file.size,
        slides: totalSlides,
        mode: local ? "local" : "server",
      });
      // A replace writes IndexedDB, never the file on disk, so the watcher's
      // reference point is still valid. What can change is *which* file is
      // watched: a pick that came with its own handle replaced the stored one,
      // so restart the watcher against it.
      if (handle) setWatchedHandleEpoch((n) => n + 1);
    },
    [local, id, applyDeckUpdate, pdfWriteAuth]
  );

  // Pill click: swap the detected recompile in for controller and viewers via
  // the ordinary replace path (one presenter-side decision for everyone).
  const applyDeckWatchUpdate = useCallback(async () => {
    const watcher = watcherRef.current;
    if (!watcher || applyingWatchRef.current) return;
    applyingWatchRef.current = true;
    setApplyingWatch(true);
    try {
      // Read the file as it is *now*: the version detected a moment ago has
      // usually been rewritten again by a watch-mode build, and its bytes no
      // longer read back.
      const update = await watcher.takeUpdate();
      if (!update) {
        window.alert("The deck file is still being written. Try again in a moment.");
        return;
      }
      await replacePdf(update.file);
      // Only move the reference point once the swap actually took, so a failed
      // replace leaves the update pending and the pill clickable.
      watcher.adopt(update.meta);
      setDeckWatchStatus("watching");
      setReloadPrompt(null);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to replace the PDF");
    } finally {
      applyingWatchRef.current = false;
      setApplyingWatch(false);
    }
  }, [replacePdf]);
  // The watcher holds this callback for as long as it runs, so it reads the
  // current one through a ref rather than being re-armed on every render.
  useEffect(() => {
    applyDeckWatchUpdateRef.current = applyDeckWatchUpdate;
  }, [applyDeckWatchUpdate]);



  // Explicit re-grant after a reload dropped the permission. Runs from the
  // pill's click, which is the user gesture requestPermission() needs.
  const resumeDeckWatch = useCallback(() => {
    void watcherRef.current?.resume();
  }, []);

  if (loading || (!error && !deck)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading presentation...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 space-y-4 text-center">
            <p className="text-3xl">😕</p>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{error}</h2>
              <p className="text-sm text-muted-foreground">
                The presentation may have expired or been ended by the presenter.
              </p>
            </div>
            <Button asChild className="w-full">
              <Link to="/">Back to Home</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (role === "viewer") {
    return (
      <ViewerView
        id={id!}
        local={!!local}
        deck={deck!}
        canvasRef={currentCanvasRef}
        blanked={blanked}
        currentSlide={displaySlide}
        outOfSync={outOfSync}
        onViewerGoTo={viewerGoTo}
        onResync={resync}
        plugins={plugins}
      />
    );
  }

  return (
    <>
      {reloadPrompt && (
        <ConfirmDeckReloadDialog
          filename={filename}
          source={reloadPrompt}
          deckEdited={deckEdited}
          busy={applyingWatch}
          onConfirm={reloadPrompt === "watch" ? applyDeckWatchUpdate : applyRemoteDeckUpdate}
          // Dismissed, not declined: the header keeps the "Deck updated" chip
          // so the update can still be applied when the moment is right.
          onClose={() => setReloadPrompt(null)}
        />
      )}
      <ControllerView
        id={id!}
        local={!!local}
        deck={deck!}
        currentSlide={currentSlide}
        onGoTo={goTo}
        onSyncAll={syncAll}
        onEnd={endPresentation}
        onSynced={() => setLocal(false)}
        onReplacePdf={replacePdf}
        currentCanvasRef={currentCanvasRef}
        currentCanvasEl={currentCanvasEl}
        blanked={blanked}
        filename={filename}
        deckWatchMode={deckWatchable ? deckWatchMode : null}
        deckWatchStatus={deckWatchStatus}
        onDeckWatchModeChange={chooseDeckWatchMode}
        onDeckWatchApply={applyDeckWatchUpdate}
        onDeckWatchResume={resumeDeckWatch}
        remoteDeckUpdate={!!remoteUpdate}
        onRemoteDeckApply={applyRemoteDeckUpdate}
        onBlankToggle={() => {
          const next = !blanked;
          // Server mode learns the new state from the socket echo; local mode has
          // no echo (BroadcastChannel doesn't deliver to the sender), so set it here.
          if (local) setBlanked(next);
          broadcast({ type: "blank_update", payload: { blanked: next } }, { event: "blank_toggle" });
        }}
        plugins={plugins}
      />
    </>
  );
}
