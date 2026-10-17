import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { cn, getSessionAuth, setSessionAuth } from "@/lib/utils";
import { Settings, TriangleAlert, Check, Option, Plus, Share2, ExternalLink, User, Puzzle, KeyRound, Keyboard, FileJson, Search, Compass, SunMoon, Sun, Moon, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { buttonVariants } from "@/components/ui/button-variants";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { CopyField } from "@/components/CopyField";
import { LoginDialog } from "@/components/LoginDialog";
import { AccountControl } from "@/components/AccountControl";
import { ControllerOnboarding } from "@/components/ControllerOnboarding";
import { NewsletterDialog } from "@/components/NewsletterDialog";
import { InstallPrompt } from "@/components/InstallPrompt";
import { useNewsletterPrompt } from "@/lib/useNewsletterPrompt";
import { useAppVersion } from "@/lib/useAppVersion";
import { DownloadButton } from "@/components/DownloadButton";
import { hasCompletedControllerOnboarding } from "@/lib/onboarding";
import { useAuth } from "@/lib/useAuth";
import { authEnabled } from "@/lib/authMode";
import { supabase } from "@/lib/supabaseClient";
import { useClaim } from "@/lib/useClaim";
import { CurrentSlideCard } from "@/components/controller/CurrentSlideCard";
import { NextSlideCard } from "@/components/controller/NextSlideCard";
import { ThumbnailsCard } from "@/components/controller/ThumbnailsCard";
import { ShortcutsEditor } from "@/components/controller/ShortcutsEditor";
import { ControllerHeader } from "@/components/controller/ControllerHeader";
import { ControllerNav, SlideCounter } from "@/components/controller/ControllerNav";
import { ControllerMenu } from "@/components/controller/ControllerMenu";
import { ControllerDashboard, type CardEntry } from "@/components/controller/ControllerDashboard";
import { ShareDialog } from "@/components/controller/ShareDialog";
import { ConfirmEndDialog } from "@/components/controller/ConfirmEndDialog";
import { useJoinUrls } from "@/lib/joinUrl";
import { ConfirmReplaceDialog } from "@/components/controller/ConfirmReplaceDialog";
import { useIsLandscape, useIsMobile } from "@/hooks/useIsMobile";
import { useSlideTapNav } from "@/hooks/useSlideTapNav";
import { useTouchPresenting } from "@/hooks/useTouchPresenting";
import {
  isDeckWatchSupported,
  PDF_PICKER_OPTIONS,
  type DeckWatchMode,
  type DeckWatchStatus,
} from "@/lib/deckWatcher";
import {
  DEFAULT_KEYMAP,
  matchesBinding,
  pluginBindings,
} from "@/lib/keymap";
import { useSetting } from "@/lib/settings";
import {
  CARD_KEYS,
  CARD_LABELS,
  defaultLayout,
  LAYOUT_PRESETS,
  type LayoutForm,
  loadLayout,
  saveLayout,
  savePreferred,
  hasPreferredLayout,
  loadPreferred,
  addLeaf,
  removeLeaf,
  restrictLayout,
  pluginPanelKey,
  visibleKeys,
} from "@/lib/controllerLayout";
import { lsGetString, lsSetString, viewerOpenedKey } from "@/lib/storage";
import { type MosaicNode } from "react-mosaic-component";
import type { Deck } from "@/lib/deck";
import type { PluginHostState } from "@/lib/plugins/usePluginHost";
import { PluginBackgrounds, PluginButtons, PluginPanel, PluginStatusItems } from "@/components/plugins/PresenterPlugins";
import { usePluginPaletteItems } from "@/components/plugins/pluginCommands";
import { CommandPalette } from "@/components/CommandPalette";
import { useControllerCommands, goToSlideItems } from "@/components/controller/controllerCommands";
import { appPaletteItems, useAppCommands } from "@/lib/commands";
import { useTheme } from "@/lib/useTheme";
import { SettingsFileSection } from "@/components/SettingsFileSection";
import { SettingsDialog } from "@/components/controller/SettingsDialog";
import { AddPluginPage, DiscoverPluginsPage, PluginPage } from "@/components/plugins/PluginSettings";
import { pluginLabel, useInstalledPlugins } from "@/lib/plugins/installed";
import { findCommand, type LoadedPlugin } from "@/lib/plugins/manifest";
import { track } from "@/lib/analytics";

// How long a pending "j<number>" jump waits for another digit before it
// commits on its own. Long enough to type a second digit, short enough that the
// presenter isn't left staring at a half-typed number.
const JUMP_IDLE_MS = 1200;

// --- Component ---

interface ControllerViewProps {
  id: string;
  local: boolean;
  deck: Deck;
  currentSlide: number;
  onGoTo: (slide: number) => void;
  onSyncAll: () => void;
  onEnd: () => void;
  onSynced: () => void;
  onReplacePdf: (file: File, handle?: FileSystemFileHandle) => Promise<void>;
  currentCanvasRef: React.RefObject<HTMLDivElement | null>;
  /** The element that ref is on now (a layout change replaces it). */
  currentCanvasEl: HTMLDivElement | null;
  blanked: boolean;
  onBlankToggle: () => void;
  /** The deck on screen, shown in the header's deck control. */
  filename: string;
  /** Live-reload preference, or null when this deck can't be watched. */
  deckWatchMode: DeckWatchMode | null;
  deckWatchStatus: DeckWatchStatus | null;
  onDeckWatchModeChange: (mode: DeckWatchMode) => void;
  onDeckWatchApply: () => void;
  onDeckWatchResume: () => void;
  /** A URL-backed deck's source PDF was republished (see Presentation). */
  remoteDeckUpdate: boolean;
  onRemoteDeckApply: () => void;
  plugins: PluginHostState;
}

/** The Settings page for an installed plugin, by its registry key (its source). */
const pluginPageId = (key: string) => `plugin:${key}`;

export function ControllerView({
  id,
  local,
  deck,
  currentSlide,
  onGoTo,
  onSyncAll,
  onEnd,
  onSynced,
  onReplacePdf,
  currentCanvasRef,
  currentCanvasEl,
  blanked,
  onBlankToggle,
  filename,
  deckWatchMode,
  deckWatchStatus,
  onDeckWatchModeChange,
  onDeckWatchApply,
  onDeckWatchResume,
  remoteDeckUpdate,
  onRemoteDeckApply,
  plugins,
}: ControllerViewProps) {
  const { totalSlides } = deck;
  const slideLinks = deck.linksBySlide.get(currentSlide) ?? [];
  const isMobile = useIsMobile();
  // A window wide enough for the dashboard but not for the full toolbars: the
  // header's three columns and the footer's six controls both stop fitting
  // well before the phone breakpoint, so from here down the header's buttons
  // and the footer's Download / End Presentation move into the slide-over
  // menu, leaving the bars with what actually gets used mid-talk — the deck
  // name up top, the page counter and Prev/Next below.
  const narrow = useIsMobile(1024) && !isMobile;
  const landscape = useIsLandscape();
  const navigate = useNavigate();
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which Settings page is showing; kept across opens so the dialog comes back
  // where the presenter left it.
  const [settingsCategory, setSettingsCategory] = useState<string | undefined>(undefined);
  const [keymap, setKeymap] = useSetting("keybindings");
  const [viewerBlocked, setViewerBlocked] = useState(false);
  const [viewerPromptDismissed, setViewerPromptDismissed] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  // Mobile-only surfaces.
  const [menuOpen, setMenuOpen] = useState(false);
  // The command palette (⌘K, or the header's search button).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [passphraseDialogOpen, setPassphraseDialogOpen] = useState(false);
  // First-run tutorial for the controller. Shown before the viewer prompt.
  const [onboardingOpen, setOnboardingOpen] = useState(() => !hasCompletedControllerOnboarding());
  // Deck replacement: pick a PDF, confirm, then hand it to the orchestrator.
  // The File is held in state between the picker and the confirmation dialog.
  const replaceFileRef = useRef<HTMLInputElement | null>(null);
  const [replaceCandidate, setReplaceCandidate] = useState<File | null>(null);
  // When the pick came from showOpenFilePicker, its handle rides along so the
  // deck keeps being watchable after the swap (see replacePdf).
  const replaceHandleRef = useRef<FileSystemFileHandle | null>(null);
  const [replacing, setReplacing] = useState(false);
  const onReplacePicked = useCallback((file: File | undefined) => {
    if (file) setReplaceCandidate(file);
  }, []);
  // Dropped onto the deck name in the header: same confirmation as a picked
  // replacement, and the handle (Chromium only) keeps the new deck watchable.
  const onDeckDropped = useCallback((file: File, handle?: FileSystemFileHandle) => {
    replaceHandleRef.current = handle ?? null;
    setReplaceCandidate(file);
  }, []);
  // Chromium picks via showOpenFilePicker so the replacement keeps a watchable
  // handle; other browsers fall back to the plain input (no watching).
  const openReplacePicker = useCallback(() => {
    if (isDeckWatchSupported()) {
      window.showOpenFilePicker?.(PDF_PICKER_OPTIONS)
        .then(async ([handle]) => {
          const file = await handle.getFile();
          // The picker's filter is a hint, not a guarantee.
          if (file.type !== "application/pdf") {
            window.alert("Please choose a PDF file");
            return;
          }
          replaceHandleRef.current = handle;
          setReplaceCandidate(file);
        })
        .catch(() => { /* cancelled: nothing to confirm */ });
      return;
    }
    replaceHandleRef.current = null;
    replaceFileRef.current?.click();
  }, []);
  const confirmReplace = useCallback(async () => {
    const file = replaceCandidate;
    if (!file || replacing) return;
    setReplacing(true);
    try {
      await onReplacePdf(file, replaceHandleRef.current ?? undefined);
      setReplaceCandidate(null);
      replaceHandleRef.current = null;
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to replace the PDF");
    } finally {
      setReplacing(false);
    }
  }, [replaceCandidate, replacing, onReplacePdf]);

  const { user } = useAuth();
  const loggedIn = !!user;
  const { syncing, syncError, sync } = useClaim(id);

  // One-time email list prompt after a few minutes of presenting. Waits for
  // the first-run tutorial to be out of the way.
  const newsletter = useNewsletterPrompt(!onboardingOpen);

  // Which build is serving this, for the settings footer. Only asked for once
  // the sheet is open, and null (rendering nothing) whenever there's no
  // versioned server to ask.
  const appVersion = useAppVersion(settingsOpen);

  // Sharing a deck that only ever lived in this browser creates its session
  // row server-side, and that is where its join code is minted — so the deck
  // is re-keyed and this window has to follow it to the new id. A deck that
  // already had a code (a POST /api/present handoff) keeps it and stays put.
  const syncOnline = async () => {
    const shared = await sync(currentSlide);
    if (!shared) return;
    onSynced();
    if (shared !== id) navigate(`/s/${shared}?role=controller`, { replace: true });
  };

  // Rather than auto-opening the viewer (which steals the active tab), prompt
  // the presenter to open it themselves. A real click keeps them on the
  // controller and avoids popup blockers. Derived rather than opened from an
  // effect: it is a question about this presentation (has a viewer been opened
  // for it before?), and the answer only changes when the presenter answers
  // it — by opening the viewer, or by waving the prompt away.
  const viewerPromptOpen =
    !viewerPromptDismissed &&
    !isMobile &&
    !onboardingOpen &&
    lsGetString(viewerOpenedKey(id)) !== "true";
  // Waving the prompt away answers it for this presentation too, so it does
  // not come back on reload.
  const dismissViewerPrompt = () => {
    lsSetString(viewerOpenedKey(id), "true");
    setViewerPromptDismissed(true);
  };

  // Tap the left/right half of the current slide to go back/forward on touch
  // devices. Disabled while pinch-zoom is active so panning or lifting
  // fingers off a zoomed slide never flips pages. (A plugin layer taking the
  // slide's input — a drawing tool — gets the taps instead.)
  const [slideZoomActive, setSlideZoomActive] = useState(false);
  // On a touch screen only the slide zooms, never the page.
  useTouchPresenting();
  useSlideTapNav(currentCanvasEl, {
    enabled: !slideZoomActive,
    onPrev: () => onGoTo(currentSlide - 1),
    onNext: () => onGoTo(currentSlide + 1),
  });

  // The dashboard is the same on every screen; only its default arrangement
  // and its stored tree differ by form factor (lib/controllerLayout), so a
  // phone starts with the current slide filling most of the column.
  const layoutForm: LayoutForm = !isMobile
    ? "desktop"
    : landscape
      ? "mobileLandscape"
      : "mobile";
  const [mosaic, setMosaic] = useState<MosaicNode<string> | null>(() => loadLayout(layoutForm));
  // Crossing the breakpoint (rotating a tablet, resizing a window) swaps in
  // that form's own tree. Adjusting during render rather than in an effect
  // keeps the dashboard from painting one frame with the wrong layout.
  const [renderedForm, setRenderedForm] = useState(layoutForm);
  if (renderedForm !== layoutForm) {
    setRenderedForm(layoutForm);
    setMosaic(loadLayout(layoutForm));
  }
  const [hasPreferred, setHasPreferred] = useState(hasPreferredLayout);
  // A card is shown iff it's a leaf in the tree; this drives the Settings checkboxes.
  const visible = new Set(visibleKeys(mosaic));

  // "j52" style jumps: the jumpToSlide binding arms digit capture, digits
  // accumulate, and Enter or a short pause commits. The pending digits live in
  // state so the footer counter can show them — a mode that silently swallows
  // keystrokes is worse than no mode at all.
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const jumpTimer = useRef<number | null>(null);

  const cancelJump = useCallback(() => {
    if (jumpTimer.current !== null) clearTimeout(jumpTimer.current);
    jumpTimer.current = null;
    setPendingJump(null);
  }, []);

  const commitJump = useCallback((digits: string) => {
    cancelJump();
    const n = parseInt(digits, 10);
    if (Number.isFinite(n)) onGoTo(Math.min(Math.max(n, 1), totalSlides));
  }, [cancelJump, onGoTo, totalSlides]);

  // Arm (or extend) digit capture. The idle timeout means "j5" alone still
  // jumps, and a stray prefix key never leaves the mode armed forever.
  const armJump = useCallback((digits: string) => {
    if (jumpTimer.current !== null) clearTimeout(jumpTimer.current);
    setPendingJump(digits);
    jumpTimer.current = window.setTimeout(() => {
      jumpTimer.current = null;
      if (digits) commitJump(digits);
      else cancelJump();
    }, JUMP_IDLE_MS);
  }, [commitJump, cancelJump]);

  // Never leave a pending jump's timer running past unmount.
  useEffect(() => cancelJump, [cancelJump]);

  const { host: pluginHost, plugins: runningPlugins } = plugins;
  // Plugins show the presenter's keys in their tooltips (presio.commands.shortcut).
  useEffect(() => pluginHost.setKeymap(keymap), [pluginHost, keymap]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K: the command palette, from anywhere (a field included).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        cancelJump();
        setPaletteOpen((open) => !open);
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      // While armed, every keystroke belongs to the jump: digits accumulate,
      // Enter commits, and anything else cancels rather than firing its own
      // shortcut halfway through a page number.
      if (pendingJump !== null) {
        // A bare modifier press isn't a decision either way.
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
        e.preventDefault();
        if (/^[0-9]$/.test(e.key)) armJump(pendingJump + e.key);
        else if (e.key === "Enter") commitJump(pendingJump);
        else cancelJump();
        return;
      }
      if (matchesBinding(e, keymap.jumpToSlide)) {
        e.preventDefault();
        armJump("");
      } else if (matchesBinding(e, keymap.firstSlide)) {
        e.preventDefault();
        onGoTo(1);
      } else if (matchesBinding(e, keymap.lastSlide)) {
        e.preventDefault();
        onGoTo(totalSlides);
      } else if (matchesBinding(e, keymap.nextSlide)) {
        e.preventDefault();
        onGoTo(currentSlide + 1);
      } else if (matchesBinding(e, keymap.prevSlide)) {
        e.preventDefault();
        onGoTo(currentSlide - 1);
      } else if (matchesBinding(e, keymap.toggleBlank)) {
        onBlankToggle();
      } else if (!e.repeat) {
        // Plugins' keybindings, after Presio's own: a key both claim is ours.
        for (const plugin of runningPlugins) {
          const { id: pluginId, manifest: { contributes } } = plugin;
          const hit = contributes.keybindings.find((kb) => matchesBinding(e, pluginBindings(keymap, pluginId, kb)));
          if (hit) {
            e.preventDefault();
            pluginHost.runCommand(pluginId, hit.command);
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentSlide, totalSlides, onGoTo, onBlankToggle, local, keymap, pendingJump, armJump, commitJump, cancelJump, runningPlugins, pluginHost]);

  const onMosaicChange = useCallback((node: MosaicNode<string> | null) => {
    setMosaic(node);
    saveLayout(layoutForm, node);
  }, [layoutForm]);

  // Applying a preset writes it to *this* screen's stored tree, so choosing
  // the desktop grid on a phone doesn't change what a desktop starts with.
  const applyPreset = useCallback((form: LayoutForm) => {
    const layout = defaultLayout(form);
    setMosaic(layout);
    saveLayout(layoutForm, layout);
  }, [layoutForm]);

  const activePreset = LAYOUT_PRESETS.find(
    (p) => JSON.stringify(mosaic) === JSON.stringify(defaultLayout(p.form))
  )?.form;

  const resetLayout = useCallback(() => {
    const fresh = defaultLayout(layoutForm);
    setMosaic(fresh);
    saveLayout(layoutForm, fresh);
  }, [layoutForm]);

  const savePreferredLayout = useCallback(() => {
    savePreferred(mosaic);
    setHasPreferred(true);
  }, [mosaic]);

  const restorePreferredLayout = useCallback(() => {
    const pref = loadPreferred();
    if (!pref) return;
    setMosaic(pref);
    saveLayout(layoutForm, pref);
  }, [layoutForm]);

  const toggleCard = useCallback((key: string) => {
    setMosaic((prev) => {
      const next = visibleKeys(prev).includes(key)
        ? removeLeaf(prev, key)
        : addLeaf(prev, key);
      saveLayout(layoutForm, next);
      return next;
    });
  }, [layoutForm]);

  // Navigations this device performs itself (viewer popup) use the page's own
  // origin — it always works locally. The share dialog's QR/links honor the
  // presenter-entered LAN address instead (lib/joinUrl.ts), so phones can scan.
  const viewerUrl = `${window.location.origin}/s/${id}?role=viewer`;
  const {
    address: lanAddress,
    setAddress: setLanAddress,
    status: lanStatus,
    origin: lanOrigin,
    shareable: lanShareable,
    controllerUrl,
    viewerUrl: shareViewerUrl,
  } = useJoinUrls(id);
  // The shared-control passphrase is minted on demand, not at import: a deck
  // that is never co-presented never needs one, and a deck that was never
  // shared has no session row to hold it. Fetched (and cached) the first time
  // the presenter asks to hand out control.
  // Tagged with the id it was read for: sharing re-keys the deck and leaves
  // this component mounted under the new id, where the previous deck's
  // passphrase would be wrong. Anything but a match falls back to whatever the
  // credential for the id on screen holds.
  const [cached, setCached] = useState(() => ({ id, value: getSessionAuth(id).passphrase ?? "" }));
  const passphrase = cached.id === id ? cached.value : (getSessionAuth(id).passphrase ?? "");
  const [passphraseBusy, setPassphraseBusy] = useState(false);
  const [passphraseError, setPassphraseError] = useState("");
  const requestPassphrase = useCallback(async () => {
    if (passphrase || passphraseBusy) return;
    setPassphraseBusy(true);
    setPassphraseError("");
    try {
      const stored = getSessionAuth(id);
      const headers: Record<string, string> = {};
      if (stored.controllerToken) headers["x-controller-token"] = stored.controllerToken;
      if (authEnabled) {
        const { data } = await supabase.auth.getSession();
        if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
      }
      const res = await fetch(`/api/sessions/${id}/passphrase`, { method: "POST", headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Couldn't create a passphrase");
      }
      const data = await res.json();
      setSessionAuth(id, { ...stored, passphrase: data.passphrase });
      setCached({ id, value: data.passphrase });
    } catch (e: unknown) {
      setPassphraseError(e instanceof Error ? e.message : "Couldn't create a passphrase");
    } finally {
      setPassphraseBusy(false);
    }
  }, [id, passphrase, passphraseBusy]);
  // Only a shared deck has a co-presenter to hand control to (and a row to
  // hold the passphrase); a local one is same-device by definition.
  const canSharePassphrase = !local;
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

  // Open the viewer in its named window (reused across opens, so no duplicates)
  // and dismiss the prompt. Passing a feature string forces a separate window
  // rather than a tab in the controller's window, so it never steals the active
  // tab here. Tracks whether a popup blocker got in the way.
  const openViewer = () => {
    const features = "popup,width=1280,height=800";
    const w = window.open(viewerUrl, `presio-viewer-${id}`, features);
    setViewerBlocked(!w);
    track("open-viewer", { blocked: !w });
    if (w) dismissViewerPrompt();
  };

  // Dashboard card content + optional toolbar action for each key.
  // Running plugins' panels (a card each), and every card the
  // Layout settings can toggle.
  const panels = plugins.plugins.flatMap((plugin) =>
    plugin.manifest.contributes.panels.map((panel) => ({ plugin, panel, key: pluginPanelKey(plugin.id, panel.id) }))
  );
  const pluginErrors = useMemo(() => ({ ...plugins.errors, ...plugins.viewerErrors }), [plugins.errors, plugins.viewerErrors]);
  const installedPlugins = useInstalledPlugins(pluginErrors);
  // A plugin some viewers couldn't load: worth a look, but only in Settings.
  const viewerFailedKey = Object.keys(plugins.viewerErrors)[0];
  // Enabled plugins' shortcuts in order: an earlier one wins a shared key.
  const pluginShortcuts = installedPlugins.flatMap(({ entry, plugin }) =>
    entry.enabled && plugin
      ? [{
          id: plugin.id,
          name: plugin.manifest.displayName,
          keybindings: plugin.manifest.contributes.keybindings.map((kb) => ({
            ...kb,
            label: findCommand(plugin.manifest, kb.command)?.title ?? kb.command,
          })),
        }]
      : []
  );
  // Switching on a plugin with panels is asking to see them.
  const showPluginPanels = (plugin: LoadedPlugin) => {
    for (const panel of plugin.manifest.contributes.panels) {
      const key = pluginPanelKey(plugin.id, panel.id);
      if (!visible.has(key)) toggleCard(key);
    }
  };
  const layoutKeys = [...CARD_KEYS, ...panels.map((p) => p.key)];
  const cardLabel = (key: string) => CARD_LABELS[key] ?? panels.find((p) => p.key === key)?.panel.title ?? key;

  const cardContent: Record<string, CardEntry> = {
    currentSlide: {
      content: (
        <CurrentSlideCard
          ref={currentCanvasRef}
          links={slideLinks}
          onLinkGoTo={onGoTo}
          onZoomActiveChange={setSlideZoomActive}
          plugins={plugins}
          slide={currentSlide}
        />
      ),
      // Plugins' buttons for the slide (the drawing tools' toggle).
      action: <PluginButtons host={plugins.host} plugins={plugins.plugins} location="controller.currentSlide" />,
    },
    nextSlide: {
      content: <NextSlideCard deck={deck} currentSlide={currentSlide} plugins={plugins} />,
    },
    thumbnails: {
      content: <ThumbnailsCard deck={deck} currentSlide={currentSlide} onGoTo={onGoTo} plugins={plugins} />,
    },
    // Each panel a running plugin contributes gets a card of its own.
    ...Object.fromEntries(
      panels.map(({ plugin, panel, key }) => [
        key,
        { title: panel.title, content: <PluginPanel host={plugins.host} plugin={plugin} panel={panel.id} /> },
      ])
    ),
  };
  // The saved layout can name tiles of plugins that aren't running (switched
  // off, or still loading); draw only what exists.
  const shownMosaic = restrictLayout(mosaic, Object.keys(cardContent));

  // Everything the palette lists: Presio's commands, then the plugins'.
  const { theme, setTheme } = useTheme();
  const appCommands = useControllerCommands(
    {
      currentSlide,
      totalSlides,
      local,
      blanked,
      isMobile,
      keymap,
      theme,
      canSharePassphrase,
      cards: layoutKeys.map((key) => ({ key, label: cardLabel(key), shown: visible.has(key) })),
      pluginPages: installedPlugins.map((plugin) => ({ id: pluginPageId(plugin.entry.key), label: pluginLabel(plugin) })),
    },
    {
      goTo: onGoTo,
      toggleBlank: onBlankToggle,
      syncAll: onSyncAll,
      share: () => setShareDialogOpen(true),
      showPassphrase: () => {
        setPassphraseDialogOpen(true);
        void requestPassphrase();
      },
      openViewer,
      switchToViewer: () => navigate(`/s/${id}?role=viewer`, { replace: true }),
      replaceDeck: openReplacePicker,
      openSettings: (page) => {
        if (page) setSettingsCategory(page);
        setSettingsOpen(true);
      },
      toggleCard,
      setTheme,
      end: () => setConfirmEnd(true),
    }
  );
  useAppCommands(pluginHost, appCommands);
  const pluginPaletteItems = usePluginPaletteItems(pluginHost, runningPlugins, keymap);

  const desktopActions = (
    <>
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        title={`Commands (${isMac ? "⌘K" : "Ctrl+K"})`}
        data-testid="open-command-palette"
        className="inline-flex items-center justify-center gap-1.5 h-8 min-w-8 px-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <Search size={15} />
        <kbd className="hidden xl:inline font-sans text-[11px] font-medium">{isMac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      {viewerFailedKey && (
        <button
          type="button"
          onClick={() => {
            setSettingsCategory(pluginPageId(viewerFailedKey));
            setSettingsOpen(true);
          }}
          title={plugins.viewerErrors[viewerFailedKey]}
          data-testid="plugin-viewer-errors"
          className="inline-flex items-center justify-center h-8 w-8 rounded-md text-amber-500 hover:bg-amber-500/10 transition-colors"
        >
          <TriangleAlert size={15} />
        </button>
      )}
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        title="Settings"
        className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <Settings size={15} />
      </button>
      <span className="text-muted-foreground/40">|</span>
      <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => setShareDialogOpen(true)}>
        Share
        <Share2 size={12} className="inline ml-1" />
      </Button>
      <span className="text-muted-foreground/40">|</span>
      <button
        type="button"
        onClick={openViewer}
        title={viewerBlocked ? "Viewer window blocked — click to open it" : "Open viewer window"}
        className={`inline-flex items-center gap-1.5 h-8 px-2.5 text-sm font-semibold rounded-md transition-colors ${viewerBlocked
          ? "text-amber-500 bg-amber-500/10 hover:bg-amber-500/20"
          : "text-foreground hover:bg-accent"
          }`}
      >
        <ExternalLink size={15} />
        Open Viewer
      </button>
    </>
  );

  const menuActions = (
    <ControllerMenu
      open={menuOpen}
      onOpen={() => setMenuOpen(true)}
      onClose={() => setMenuOpen(false)}
      deck={deck}
      pluginHost={plugins.host}
      canSharePassphrase={canSharePassphrase}
      onShare={() => setShareDialogOpen(true)}
      onShowPassphrase={() => { setPassphraseDialogOpen(true); void requestPassphrase(); }}
      onSwitchToViewer={isMobile ? () => navigate(`/s/${id}?role=viewer`, { replace: true }) : undefined}
      onReplaceClick={openReplacePicker}
      onEndClick={() => setConfirmEnd(true)}
      onSettings={() => setSettingsOpen(true)}
      onOpenViewer={isMobile ? undefined : openViewer}
      onCommands={() => setPaletteOpen(true)}
    />
  );

  return (
    // Safe-area padding is a no-op in browser tabs (viewport-fit=cover is
    // opted into only when installed — see main.tsx) and keeps the header /
    // nav bar clear of the notch and home indicator in the installed app.
    <div
      className={cn(
        "bg-background flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
        isMobile ? "h-dvh" : "h-screen"
      )}
    >
      <PluginBackgrounds host={plugins.host} plugins={plugins.plugins} />
      <ControllerHeader
        id={id}
        local={local}
        blanked={blanked}
        compact={isMobile}
        filename={filename}
        deckWatchMode={deckWatchMode}
        deckWatchStatus={deckWatchStatus}
        onReplaceDeck={openReplacePicker}
        onDropDeck={onDeckDropped}
        onDeckWatchModeChange={onDeckWatchModeChange}
        onDeckWatchApply={onDeckWatchApply}
        onDeckWatchResume={onDeckWatchResume}
        remoteDeckUpdate={remoteDeckUpdate}
        onRemoteDeckApply={onRemoteDeckApply}
        onCodeClick={() => setShareDialogOpen(true)}
        status={<PluginStatusItems host={plugins.host} plugins={plugins.plugins} compact={isMobile} />}
        actions={isMobile || narrow ? menuActions : desktopActions}
      />

      <ControllerDashboard
        value={shownMosaic}
        onChange={onMosaicChange}
        cards={cardContent}
        onHideCard={toggleCard}
      />

      {isMobile ? (
        <div className="border-t px-3 py-3 space-y-2">
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <SlideCounter
              className="text-xs text-muted-foreground"
              currentSlide={currentSlide}
              totalSlides={totalSlides}
              onGoTo={onGoTo}
              pendingJump={pendingJump}
            />
            {!local && (
              <Button variant="ghost" size="sm" onClick={onSyncAll}>
                Sync All
              </Button>
            )}
            <PluginButtons host={plugins.host} plugins={plugins.plugins} location="controller.toolbar" />
          </div>
          <ControllerNav
            size="lg"
            showCount={false}
            currentSlide={currentSlide}
            totalSlides={totalSlides}
            onGoTo={onGoTo}
            className="gap-2"
          />
        </div>
      ) : (
        // Navigation first and centred; the session controls sit beside it,
        // and the two "leaving the deck" actions are pushed to the far end —
        // until the window is narrow, where they live in the header menu and
        // the bar keeps only what is used while presenting.
        <div className={cn("border-t flex shrink-0 items-center justify-center", narrow ? "gap-3 p-3" : "gap-4 p-4")}>
          <ControllerNav
            className={narrow ? "gap-3" : "gap-4"}
            currentSlide={currentSlide}
            totalSlides={totalSlides}
            onGoTo={onGoTo}
            pendingJump={pendingJump}
          />
          {!local && (
            <Button variant="ghost" size="sm" onClick={onSyncAll} title="Bring all viewers back to the current slide">
              Sync All
            </Button>
          )}
          <PluginButtons host={plugins.host} plugins={plugins.plugins} location="controller.toolbar" />
          {!narrow && (
            <div className="ml-auto flex items-center gap-2">
              <DownloadButton deck={deck} plugins={plugins.host} />
              <Button variant="destructive" size="sm" onClick={() => setConfirmEnd(true)}>
                End Presentation
              </Button>
            </div>
          )}
        </div>
      )}

      {shareDialogOpen && (
        <ShareDialog
          id={id}
          viewerUrl={shareViewerUrl}
          controllerUrl={controllerUrl}
          lanAddress={lanAddress}
          onLanAddressChange={setLanAddress}
          lanStatus={lanStatus}
          lanOrigin={lanOrigin}
          lanShareable={lanShareable}
          local={local}
          loggedIn={loggedIn}
          syncing={syncing}
          syncError={syncError}
          onLogin={() => setLoginOpen(true)}
          onSync={syncOnline}
          onClose={() => setShareDialogOpen(false)}
          maxWidth={isMobile ? "max-w-[90%]" : "max-w-[50%]"}
        />
      )}

      {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          activeId={settingsCategory}
          onActiveChange={setSettingsCategory}
          footer={
            appVersion && (
              <p className="text-xs font-mono text-muted-foreground" data-testid="app-version">
                {appVersion}
              </p>
            )
          }
          categories={[
            ...(authEnabled
              ? [{ id: "account", label: "Account", icon: User, content: <AccountControl variant="section" /> }]
              : []),
            {
              id: "layout",
              label: "Appearance",
              icon: SunMoon,
              description: "The theme, and which cards the dashboard shows and how they're arranged.",
              content: (
                <div className="space-y-2">
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">Theme</p>
                    <ButtonGroup>
                      {([
                        ["system", "System", Monitor],
                        ["light", "Light", Sun],
                        ["dark", "Dark", Moon],
                      ] as const).map(([value, label, Icon]) => (
                        <Button
                          key={value}
                          size="sm"
                          variant={theme === value ? "secondary" : "outline"}
                          aria-pressed={theme === value}
                          onClick={() => setTheme(value)}
                        >
                          <Icon size={14} className="mr-1.5" />
                          {label}
                        </Button>
                      ))}
                    </ButtonGroup>
                  </div>
                  <p className="pt-2 text-xs font-medium text-muted-foreground">Dashboard cards</p>
                  <div className="space-y-0.5">
                    {layoutKeys.map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => toggleCard(key)}
                        className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent transition-colors text-left"
                      >
                        <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${visible.has(key) ? "bg-primary border-primary text-primary-foreground" : "border-input"
                          }`}>
                          {visible.has(key) && <Check size={11} strokeWidth={3} />}
                        </span>
                        {cardLabel(key)}
                      </button>
                    ))}
                  </div>
                  <div className="space-y-1.5 pt-1">
                    <label
                      htmlFor="layout-preset"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Preset
                    </label>
                    <select
                      id="layout-preset"
                      // "Custom" isn't a preset you can pick — it is what the field
                      // reads once the cards have been dragged away from one.
                      value={activePreset ?? "custom"}
                      onChange={(e) => applyPreset(e.target.value as LayoutForm)}
                      className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {activePreset === undefined && (
                        <option value="custom" disabled>
                          Custom
                        </option>
                      )}
                      {LAYOUT_PRESETS.map((preset) => (
                        <option key={preset.form} value={preset.form} title={preset.hint}>
                          {preset.label}
                          {preset.form === layoutForm ? " (default for this screen)" : ""}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      {LAYOUT_PRESETS.find((p) => p.form === activePreset)?.hint ??
                        "Your own arrangement — pick a preset to start over."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button size="sm" variant="outline" onClick={savePreferredLayout}>
                      Save as preferred
                    </Button>
                    {hasPreferred && (
                      <Button size="sm" variant="outline" onClick={restorePreferredLayout}>
                        Restore preferred
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={resetLayout}>
                      Reset to default
                    </Button>
                  </div>
                </div>
              ),
            },
            ...(canSharePassphrase
              ? [{
                id: "control",
                label: "Shared control",
                icon: KeyRound,
                description: "Share this passphrase to grant controller access.",
                content: (
                  <>
                    {passphrase ? (
                      <CopyField label="" value={passphrase} />
                    ) : (
                      <div className="space-y-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={passphraseBusy}
                          onClick={requestPassphrase}
                        >
                          {passphraseBusy ? "Creating…" : "Create passphrase"}
                        </Button>
                        {passphraseError && (
                          <p className="text-xs text-destructive">{passphraseError}</p>
                        )}
                      </div>
                    )}
                  </>
                ),
              }]
              : []),
            {
              id: "shortcuts",
              label: "Keyboard shortcuts",
              icon: Keyboard,
              action: (
                <Button size="sm" variant="ghost" onClick={() => setKeymap(DEFAULT_KEYMAP)}>
                  Reset defaults
                </Button>
              ),
              content: (
                <ShortcutsEditor
                  keymap={keymap}
                  onChange={setKeymap}
                  plugins={pluginShortcuts}
                />
              ),
            },
            {
              id: "file",
              label: "Settings file",
              icon: FileJson,
              description: "All of these settings, plugins' included, as one settings.json — to back up or use in another browser.",
              content: <SettingsFileSection />,
            },
            // A page to discover plugins, one per installed plugin, then one to add another.
            {
              id: "discover-plugins",
              group: "Plugins",
              label: "Discover plugins",
              icon: Compass,
              description:
                "Published on GitHub by anyone. Only add plugins you trust.",
              content: (
                <DiscoverPluginsPage
                  onAdded={(key, plugin) => {
                    showPluginPanels(plugin);
                    setSettingsCategory(pluginPageId(key));
                  }}
                />
              ),
            },
            ...installedPlugins.map((plugin) => ({
              id: pluginPageId(plugin.entry.key),
              group: "Plugins",
              label: pluginLabel(plugin),
              icon: Puzzle,
              dimmed: !plugin.entry.enabled,
              description: plugin.plugin?.manifest.description,
              content: (
                <PluginPage
                  plugin={plugin}
                  host={plugins.host}
                  running={plugins.plugins.find((p) => p.key === plugin.entry.key)}
                  onEnabled={showPluginPanels}
                  shortcutsBefore={pluginShortcuts.slice(0, Math.max(0, pluginShortcuts.findIndex((p) => p.id === plugin.plugin?.id)))}
                />
              ),
            })),
            {
              id: "add-plugin",
              group: "Plugins",
              label: "Add plugin",
              icon: Plus,
              description:
                "From GitHub or a URL. Only add plugins you trust.",
              content: (
                <AddPluginPage
                  onDiscover={() => setSettingsCategory("discover-plugins")}
                  onAdded={(key, plugin) => {
                    showPluginPanels(plugin);
                    setSettingsCategory(pluginPageId(key));
                  }}
                />
              ),
            },
          ]}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          items={[...appPaletteItems(appCommands), ...pluginPaletteItems]}
          extraItems={(query) => goToSlideItems(query, totalSlides, onGoTo)}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {confirmEnd && (
        <ConfirmEndDialog local={local} onConfirm={onEnd} onClose={() => setConfirmEnd(false)} />
      )}

      {replaceCandidate && (
        <ConfirmReplaceDialog
          onConfirm={confirmReplace}
          onClose={() => { if (!replacing) setReplaceCandidate(null); }}
        />
      )}

      {/* Always mounted: both the desktop Settings button and the mobile menu
          item trigger this picker, which then opens the confirm dialog. */}
      <input
        ref={replaceFileRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        data-testid="deck-replace-input"
        onChange={(e) => {
          onReplacePicked(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {passphraseDialogOpen && (
        <DialogOverlay onClose={() => setPassphraseDialogOpen(false)} maxWidth="max-w-xs">
          <div className="text-center space-y-3">
            <h2 className="text-lg font-semibold">Controller Passphrase</h2>
            <p className="text-xs text-muted-foreground">
              Share this passphrase to grant controller access
            </p>
            {passphrase ? (
              <>
                <p className="text-2xl font-bold tracking-widest font-mono select-all">
                  {passphrase}
                </p>
                <CopyField label="" value={passphrase} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {passphraseError || "Creating…"}
              </p>
            )}
          </div>
          <Button className="w-full" variant="ghost" onClick={() => setPassphraseDialogOpen(false)}>
            Close
          </Button>
        </DialogOverlay>
      )}

      {!isMobile && viewerPromptOpen && (
        <DialogOverlay onClose={dismissViewerPrompt}>
          <div className="flex flex-col items-center gap-4 text-center">
            <p className="text-xs text-muted-foreground">
              Hold <span className="font-medium text-foreground">{isMac ? "⌥ Option" : "Option/Alt"}</span> and click to open it in its own window.
              <br />
              <br />
              Drag the new window to a different screen to present.
            </p>
            <div className="flex items-center gap-2">
              <kbd className="inline-flex items-center justify-center h-9 min-w-9 px-2 rounded-md border border-border bg-muted text-sm font-medium text-muted-foreground shadow-sm">
                {isMac ? <Option size={15} /> : "Option/Alt"}
              </kbd>
              <Plus size={14} className="text-muted-foreground" />
              <button
                type="button"
                onClick={openViewer}
                className={cn(buttonVariants({ variant: "default" }))}
              >
                Open Viewer Window
              </button>
            </div>
            <button
              type="button"
              onClick={dismissViewerPrompt}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4 mt-2"
            >
              Not now
            </button>
          </div>
        </DialogOverlay>
      )}

      {!isMobile && onboardingOpen && (
        <ControllerOnboarding
          onClose={() => setOnboardingOpen(false)}
          onOpenViewer={openViewer}
        />
      )}

      {newsletter.open && <NewsletterDialog onClose={newsletter.close} />}

      {/* Add-to-home-screen — touch devices using this phone/tablet as the
          presenter's controller. Self-gates to touch + not-installed + once. */}
      <InstallPrompt />
    </div>
  );
}
