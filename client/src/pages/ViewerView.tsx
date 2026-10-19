import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { RotateCw, EllipsisVertical, ArrowLeft, ArrowRight, ChevronFirst, ChevronLast, Hash, Maximize, Minimize, MonitorCog, House, Puzzle } from "lucide-react";
import { getSessionAuth, setSessionAuth } from "@/lib/utils";
import { appOrigin, onViewerOrigin, TAKEOVER_PARAM } from "@/lib/origins";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { SessionQRCode } from "@/components/SessionQRCode";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";
import { LinkOverlay } from "@/components/LinkOverlay";
import type { Deck } from "@/lib/deck";
import { DownloadButton } from "@/components/DownloadButton";
import { ViewerHint } from "@/components/ViewerHint";
import { ViewerPluginLayer } from "@/components/plugins/ViewerPluginLayer";
import { SlideLayers } from "@/components/plugins/SlideLayers";
import type { PluginHostState } from "@/lib/plugins/usePluginHost";
import { ViewerPluginList, ViewerSheets, ViewerToolbar } from "@/components/plugins/ViewerPlugins";
import { usePluginPaletteItems } from "@/components/plugins/pluginCommands";
import { CommandPalette } from "@/components/CommandPalette";
import { goToSlideItems } from "@/components/controller/controllerCommands";
import { appPaletteItems, slideArg, useAppCommands, type AppCommand } from "@/lib/commands";
import { runsOnViewer, useViewerPluginSwitches } from "@/lib/plugins/viewerSwitches";
import { track } from "@/lib/analytics";
import { isEditableTarget } from "@/lib/keymap";

export function ViewerView({
  id,
  local,
  deck,
  canvasRef,
  blanked,
  currentSlide,
  outOfSync,
  onViewerGoTo,
  onResync,
  plugins,
}: {
  id: string;
  local: boolean;
  deck: Deck;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  blanked: boolean;
  currentSlide: number;
  outOfSync: boolean;
  onViewerGoTo: (slide: number) => void;
  onResync: () => void;
  plugins: PluginHostState;
}) {
  const { totalSlides } = deck;
  const navigate = useNavigate();
  const [cursorVisible, setCursorVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Opened straight away when a viewer on the viewer origin handed over here
  // to take control (see the menu below).
  const [authOpen, setAuthOpen] = useState(() => new URLSearchParams(window.location.search).has(TAKEOVER_PARAM));
  const [passphrase, setPassphrase] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Arming the countdown is separate from showing the cursor, so mounting can
  // start the clock without a state update: the cursor is already visible.
  const armHide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!menuOpen && !authOpen && !paletteOpen) setCursorVisible(false);
    }, 3000);
  }, [menuOpen, authOpen, paletteOpen]);

  const resetTimer = useCallback(() => {
    setCursorVisible(true);
    armHide();
  }, [armHide]);

  useEffect(() => {
    armHide();
    window.addEventListener("mousemove", resetTimer);
    return () => {
      window.removeEventListener("mousemove", resetTimer);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [armHide, resetTimer]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Plugins this viewer turned off don't run here: their surfaces aren't
  // mounted, and their buttons aren't drawn.
  const switches = useViewerPluginSwitches();
  const running = useMemo(
    () => ({ ...plugins, plugins: plugins.plugins.filter((p) => !switches.isOff(p.id)) }),
    [plugins, switches]
  );

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else {
      track("viewer-fullscreen");
      void document.documentElement.requestFullscreen();
    }
  }, []);

  // The viewer's own commands, for the palette; navigating ones only where
  // this viewer may move on its own (a local viewer mirrors the presenter),
  // and those plugins can run too (presio.commands.execute).
  const clamp = (n: number) => Math.min(Math.max(n, 1), totalSlides);
  const appCommands: AppCommand[] = [
    ...(!local
      ? [
          { id: "nextSlide", title: "Next slide", category: "Navigation", icon: ArrowRight, shortcut: "→", exposed: true, run: () => onViewerGoTo(clamp(currentSlide + 1)) },
          { id: "prevSlide", title: "Previous slide", category: "Navigation", icon: ArrowLeft, shortcut: "←", exposed: true, run: () => onViewerGoTo(clamp(currentSlide - 1)) },
          { id: "firstSlide", title: "First slide", category: "Navigation", icon: ChevronFirst, exposed: true, run: () => onViewerGoTo(1) },
          { id: "lastSlide", title: "Last slide", category: "Navigation", icon: ChevronLast, exposed: true, run: () => onViewerGoTo(totalSlides) },
          { id: "goToSlide", title: "Go to slide…", category: "Navigation", icon: Hash, prefill: "slide ", exposed: true, run: (args: Record<string, unknown>) => onViewerGoTo(clamp(slideArg(args))) },
          ...(outOfSync ? [{ id: "resync", title: "Follow the presenter again", category: "Navigation", icon: RotateCw, keywords: "sync", run: onResync }] : []),
        ]
      : []),
    { id: "fullscreen", title: isFullscreen ? "Exit fullscreen" : "Enter fullscreen", category: "Viewer", icon: isFullscreen ? Minimize : Maximize, shortcut: "F", run: toggleFullscreen },
    { id: "switchToController", title: "Switch to the controller", category: "Viewer", icon: MonitorCog, keywords: "present take control", run: () => switchToController() },
    { id: "home", title: "Back to home", category: "Viewer", icon: House, run: () => navigate("/") },
    ...plugins.plugins.filter((p) => runsOnViewer(p.manifest)).map((p): AppCommand => {
      const off = switches.isOff(p.id);
      return {
        id: `pluginSwitch:${p.id}`,
        title: `Turn ${p.manifest.displayName} ${off ? "on" : "off"} on this device`,
        category: "Plugins",
        icon: Puzzle,
        keywords: "plugin disable enable",
        run: () => switches.setOff(p.id, !off),
      };
    }),
  ];
  useAppCommands(plugins.host, appCommands);
  const pluginPaletteItems = usePluginPaletteItems(plugins.host, running.plugins, null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // The passphrase field lives on this page too.
      if (isEditableTarget(e.target)) return;
      if (e.key === "f" || e.key === "F") {
        toggleFullscreen();
      } else if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        onViewerGoTo(currentSlide + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        onViewerGoTo(currentSlide - 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentSlide, onViewerGoTo, toggleFullscreen]);

  // Take control: on the viewer origin the controller token must never be
  // stored (lib/origins.ts), so ask for the passphrase on the app origin.
  const switchToController = () => {
    if (onViewerOrigin) {
      window.location.assign(`${appOrigin}/s/${id}?role=viewer&${TAKEOVER_PARAM}=1`);
      return;
    }
    // Local sessions are same-device; no passphrase gate needed.
    const { controllerToken } = getSessionAuth(id);
    if (local || controllerToken) {
      navigate(`/s/${id}?role=controller`, { replace: true });
    } else {
      setMenuOpen(false);
      setAuthOpen(true);
    }
  };

  const submitPassphrase = async () => {
    setAuthError("");
    setAuthLoading(true);
    try {
      const res = await fetch(`/api/sessions/${id}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Authentication failed");
      }
      const data = await res.json();
      setSessionAuth(id, {
        controllerToken: data.controllerToken,
        passphrase: data.passphrase,
      });
      navigate(`/s/${id}?role=controller`, { replace: true });
    } catch (e: unknown) {
      setAuthError(e instanceof Error ? e.message : "Authentication failed");
    } finally {
      setAuthLoading(false);
    }
  };

  return (
    // Safe-area padding is a no-op in browser tabs (viewport-fit=cover is
    // opted into only when installed — see main.tsx) and keeps the slide
    // clear of the notch and home indicator in the installed app.
    <div
      className="h-screen w-screen bg-black flex items-center justify-center relative pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      style={{ cursor: cursorVisible ? "default" : "none" }}
    >
      <div ref={canvasRef} data-testid="viewer-slide" data-slide={currentSlide} className="w-full h-full relative" />
      {/* Plugins' live layers on the slide (media, drawings, …): on the page,
          over its links (which they let through), under the blank cover. */}
      <SlideLayers plugins={running} slide={currentSlide} mode="live" containerRef={canvasRef} />

      {/* Internal links move this viewer only, and only when it is allowed to
          navigate independently — a local viewer mirrors the controller, so it
          gets no handler and those links stay inert. External links always
          open. Hidden while blanked so nothing is clickable behind the cover. */}
      {!blanked && (
        <LinkOverlay
          canvasContainerRef={canvasRef}
          links={deck.linksBySlide.get(currentSlide) ?? []}
          onGoToSlide={local ? undefined : onViewerGoTo}
        />
      )}

      <ViewerHint canNavigate={!local} />

      {blanked && (
        <div className="absolute inset-0 bg-black z-10 flex items-center justify-center">
          <p className={`text-white/50 text-sm select-none transition-opacity duration-300 ${
            cursorVisible ? "opacity-100" : "opacity-0"
          }`}>
            Screen blanked by presenter
          </p>
        </div>
      )}

      <ViewerPluginLayer host={plugins.host} plugins={running.plugins} />
      <ViewerSheets host={plugins.host} plugins={running.plugins} />

      <div className="absolute top-4 left-4 flex items-center gap-2">
        {outOfSync ? (
          <button
            onClick={onResync}
            title="Out of sync — click to follow the presenter"
            className="flex items-center gap-1.5 rounded-full bg-amber-500/20 px-2 py-1 text-amber-300 hover:bg-amber-500/30 hover:text-amber-200 transition-colors cursor-pointer"
          >
            <RotateCw size={14} />
            <span className="text-xs font-medium">Sync</span>
          </button>
        ) : (
          <span className={`transition-opacity duration-300 ${
            cursorVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}>
            <ConnectionIndicator dark local={local} />
          </span>
        )}
        {outOfSync && (
          <span className="text-white/40 text-xs tabular-nums select-none">
            {currentSlide} / {totalSlides}
          </span>
        )}
      </div>

      {/* Plugins' buttons for the audience, then the menu; both fade with
          the cursor. */}
      <div
        className={`absolute top-4 right-4 flex items-center gap-2 transition-opacity duration-300 ${
          cursorVisible ? "" : "opacity-0 pointer-events-none"
        }`}
      >
        <div className="flex items-center gap-2 opacity-90 hover:opacity-100 transition-opacity">
          <ViewerToolbar host={plugins.host} plugins={running.plugins} />
        </div>
        <button
          onClick={() => setMenuOpen(true)}
          aria-label="Menu"
          className="p-2 rounded-full bg-black/20 hover:bg-black/30 text-white backdrop-blur drop-shadow-md cursor-pointer opacity-70 hover:opacity-100 transition-opacity"
        >
          <EllipsisVertical size={20} />
        </button>
      </div>

      {menuOpen && (
        <DialogOverlay onClose={() => setMenuOpen(false)} maxWidth="max-w-xs">
          {!local && <SessionQRCode sessionId={id} size={160} />}
          <div className="space-y-2">
            <Button
              className="w-full"
              variant="outline"
              onClick={switchToController}
            >
              Switch to Controller
            </Button>
            <DownloadButton deck={deck} plugins={plugins.host} variant="outline" size="default" block />
            <Button
              className="w-full"
              variant="outline"
              onClick={() => {
                toggleFullscreen();
                setMenuOpen(false);
              }}
            >
              {isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
            </Button>
            <Button className="w-full" variant="outline" onClick={() => navigate("/")}>
              Back to Home
            </Button>
          </div>
          <ViewerPluginList plugins={plugins.plugins} switches={switches} />
          <Button className="w-full" variant="ghost" onClick={() => setMenuOpen(false)}>
            Close
          </Button>
        </DialogOverlay>
      )}

      {paletteOpen && (
        <CommandPalette
          items={[...appPaletteItems(appCommands), ...pluginPaletteItems]}
          extraItems={local ? undefined : (query) => goToSlideItems(query, totalSlides, onViewerGoTo)}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {authOpen && (
        <DialogOverlay onClose={() => { setAuthOpen(false); setAuthError(""); setPassphrase(""); }} maxWidth="max-w-xs">
          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-center">Enter Passphrase</h2>
            <p className="text-xs text-muted-foreground text-center">
              Enter the controller passphrase to take control of this presentation.
            </p>
            <input
              type="text"
              placeholder="Passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value.toUpperCase())}
              maxLength={8}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-center text-lg font-mono tracking-widest placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(e) => { if (e.key === "Enter") submitPassphrase(); }}
              autoFocus
            />
            {authError && (
              <p className="text-sm text-destructive text-center">{authError}</p>
            )}
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" variant="outline" onClick={() => { setAuthOpen(false); setAuthError(""); setPassphrase(""); }}>
              Cancel
            </Button>
            <Button className="flex-1" disabled={!passphrase || authLoading} onClick={submitPassphrase}>
              {authLoading ? "Verifying..." : "Submit"}
            </Button>
          </div>
        </DialogOverlay>
      )}
    </div>
  );
}
