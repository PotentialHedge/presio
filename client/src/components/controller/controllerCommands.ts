// The controller's own commands, for the command palette (and, the
// navigation ones, for plugins: presio.commands.execute("presio.nextSlide")).
// Built on every render from the controller's state and handlers, so each
// one acts on what's on screen now.

import {
  ArrowLeft,
  ArrowRight,
  ChevronFirst,
  ChevronLast,
  EyeOff,
  Eye,
  Hash,
  Share2,
  ExternalLink,
  MonitorPlay,
  KeyRound,
  RefreshCw,
  Settings,
  Keyboard,
  LayoutGrid,
  Compass,
  Plus,
  Puzzle,
  Power,
  Sun,
  Moon,
  Monitor,
  Users,
  PanelTop,
} from "lucide-react";
import { formatBinding, type Keymap, type KeymapAction } from "@/lib/keymap";
import { slideArg, slideFromQuery, type AppCommand, type PaletteItem } from "@/lib/commands";
import type { Theme } from "@/lib/useTheme";

export interface ControllerCommandState {
  currentSlide: number;
  totalSlides: number;
  local: boolean;
  blanked: boolean;
  isMobile: boolean;
  keymap: Keymap;
  theme: Theme;
  canSharePassphrase: boolean;
  /** Dashboard cards that can be shown or hidden, and whether each is. */
  cards: { key: string; label: string; shown: boolean }[];
  /** Installed plugins' Settings pages. */
  pluginPages: { id: string; label: string }[];
}

export interface ControllerCommandActions {
  goTo(slide: number): void;
  toggleBlank(): void;
  syncAll(): void;
  share(): void;
  showPassphrase(): void;
  openViewer(): void;
  switchToViewer(): void;
  replaceDeck(): void;
  /** Open Settings, on a page when given. */
  openSettings(page?: string): void;
  toggleCard(key: string): void;
  setTheme(theme: Theme): void;
  end(): void;
}

// A hook in name only (it calls none): the actions close over the page's refs,
// which the lint allows handing to a hook but not to a plain function.
export function useControllerCommands(s: ControllerCommandState, a: ControllerCommandActions): AppCommand[] {
  const key = (action: KeymapAction) => {
    const first = s.keymap[action][0];
    return first ? formatBinding(first) : undefined;
  };
  const clamp = (n: number) => Math.min(Math.max(n, 1), s.totalSlides);
  const nav = "Navigation";
  const presenting = "Presenting";
  const settings = "Settings";
  const commands: AppCommand[] = [
    { id: "nextSlide", title: "Next slide", category: nav, icon: ArrowRight, shortcut: key("nextSlide"), exposed: true, run: () => a.goTo(clamp(s.currentSlide + 1)) },
    { id: "prevSlide", title: "Previous slide", category: nav, icon: ArrowLeft, shortcut: key("prevSlide"), keywords: "back", exposed: true, run: () => a.goTo(clamp(s.currentSlide - 1)) },
    { id: "firstSlide", title: "First slide", category: nav, icon: ChevronFirst, shortcut: key("firstSlide"), keywords: "start beginning", exposed: true, run: () => a.goTo(1) },
    { id: "lastSlide", title: "Last slide", category: nav, icon: ChevronLast, shortcut: key("lastSlide"), keywords: "end", exposed: true, run: () => a.goTo(s.totalSlides) },
    // Listed as a prompt for a number; plugins run it with { slide }.
    { id: "goToSlide", title: "Go to slide…", category: nav, icon: Hash, shortcut: key("jumpToSlide"), keywords: "jump page number", prefill: "slide ", exposed: true, run: (args) => a.goTo(clamp(slideArg(args))) },
    {
      id: "toggleBlank",
      title: s.blanked ? "Unblank the screen" : "Blank the screen",
      category: presenting,
      icon: s.blanked ? Eye : EyeOff,
      shortcut: key("toggleBlank"),
      keywords: "black hide",
      run: () => a.toggleBlank(),
    },
  ];
  if (!s.local) {
    commands.push({ id: "syncAll", title: "Bring all viewers to this slide", category: presenting, icon: Users, keywords: "sync all", run: () => a.syncAll() });
  }
  commands.push(
    s.isMobile
      ? { id: "switchToViewer", title: "Switch this device to the viewer", category: presenting, icon: MonitorPlay, run: () => a.switchToViewer() }
      : { id: "openViewer", title: "Open the viewer window", category: presenting, icon: ExternalLink, keywords: "projector screen", run: () => a.openViewer() },
    { id: "share", title: "Share…", category: presenting, icon: Share2, keywords: "join code link qr invite", run: () => a.share() }
  );
  if (s.canSharePassphrase) {
    commands.push({ id: "showPassphrase", title: "Show the controller passphrase", category: presenting, icon: KeyRound, keywords: "shared control", run: () => a.showPassphrase() });
  }
  commands.push(
    { id: "replaceDeck", title: "Replace the PDF…", category: presenting, icon: RefreshCw, keywords: "deck file swap", run: () => a.replaceDeck() },
    { id: "endPresentation", title: "End the presentation…", category: presenting, icon: Power, keywords: "stop quit", run: () => a.end() },
    { id: "openSettings", title: "Open settings", category: settings, icon: Settings, keywords: "preferences", run: () => a.openSettings() },
    { id: "openShortcuts", title: "Keyboard shortcuts", category: settings, icon: Keyboard, keywords: "keys bindings", run: () => a.openSettings("shortcuts") },
    { id: "openLayout", title: "Dashboard layout", category: settings, icon: LayoutGrid, keywords: "cards arrange", run: () => a.openSettings("layout") },
    ...s.cards.map(
      (card): AppCommand => ({
        id: `toggleCard:${card.key}`,
        title: `${card.shown ? "Hide" : "Show"} the ${card.label} card`,
        category: settings,
        icon: PanelTop,
        keywords: "layout dashboard panel",
        run: () => a.toggleCard(card.key),
      })
    ),
    ...s.pluginPages.map(
      (page): AppCommand => ({
        id: `pluginSettings:${page.id}`,
        title: `${page.label} settings`,
        category: settings,
        icon: Puzzle,
        keywords: "plugin",
        run: () => a.openSettings(page.id),
      })
    ),
    { id: "discoverPlugins", title: "Discover plugins…", category: settings, icon: Compass, keywords: "browse find extension", run: () => a.openSettings("discover-plugins") },
    { id: "addPlugin", title: "Add a plugin…", category: settings, icon: Plus, keywords: "install extension", run: () => a.openSettings("add-plugin") },
    ...(["light", "dark", "system"] as const)
      .filter((t) => t !== s.theme)
      .map(
        (t): AppCommand => ({
          id: `theme:${t}`,
          title: `Use the ${t === "system" ? "system" : t} theme`,
          category: settings,
          icon: t === "light" ? Sun : t === "dark" ? Moon : Monitor,
          keywords: "appearance dark mode light mode",
          run: () => a.setTheme(t),
        })
      )
  );
  return commands;
}

/** "Go to slide 12" while a slide number is typed into the palette. */
export function goToSlideItems(query: string, total: number, goTo: (slide: number) => void): PaletteItem[] {
  const n = slideFromQuery(query, total);
  if (n === null) return [];
  return [{ id: `presio.goToSlide:${n}`, title: `Go to slide ${n}`, category: "Navigation", icon: Hash, run: () => goTo(n) }];
}
