// Commands: everything the command palette (⌘K) lists. Presio's own actions
// are commands too, "presio.<id>", built by the page that owns them (the
// controller, the viewer) from its current state; plugins' commands come from
// their manifests (components/plugins/pluginCommands.ts). The ones Presio
// marks `exposed` plugins can also run, with presio.commands.execute
// ("presio.nextSlide") — see useAppCommands.

import { useEffect, type ComponentType } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";
import { APP_COMMAND_PREFIX, type PluginHost } from "@/lib/plugins/host";

type Icon = ComponentType<{ size?: number; className?: string }>;

/** One row of the palette. */
export interface PaletteItem {
  /** Unique: "presio.nextSlide", "presio/timer.toggle". */
  id: string;
  title: string;
  /** The group it's listed under: "Navigation", a plugin's name. */
  category: string;
  icon?: Icon;
  /** Its key, as shown ("→", "⌘Z"). */
  shortcut?: string;
  /** More words it's found by ("blank black screen"). */
  keywords?: string;
  disabled?: boolean;
  /** Choosing it fills the search box with this instead of running anything
   *  ("Go to slide…" → "slide "). */
  prefill?: string;
  run?: () => void;
}

/** One of Presio's own commands. */
export interface AppCommand extends Omit<PaletteItem, "id" | "category" | "run"> {
  /** Without the prefix: "nextSlide" is "presio.nextSlide". */
  id: string;
  category?: string;
  /** Plugins may run it, with args (presio.commands.execute). */
  exposed?: boolean;
  /** Not listed in the palette (one that needs args, like goToSlide). */
  hidden?: boolean;
  run(args: Record<string, unknown>): unknown;
}

/** Presio's commands as palette rows. */
export function appPaletteItems(commands: AppCommand[]): PaletteItem[] {
  return commands
    .filter((c) => !c.hidden)
    .map((c) => ({
      id: APP_COMMAND_PREFIX + c.id,
      title: c.title,
      category: c.category ?? "Presio",
      icon: c.icon,
      shortcut: c.shortcut,
      keywords: c.keywords,
      disabled: c.disabled,
      prefill: c.prefill,
      run: c.disabled ? undefined : () => void c.run({}),
    }));
}

/**
 * Hand the page's commands to the plugin host, so plugins can run the
 * exposed ones. Looked up on each call, so a command always acts on the
 * page's latest state (the slide it's on now).
 */
export function useAppCommands(host: PluginHost, commands: AppCommand[]) {
  const latest = useLatestRef(commands);
  useEffect(() => {
    host.setAppCommands((id) => latest.current.find((c) => c.id === id && !c.disabled));
    return () => host.setAppCommands(() => undefined);
  }, [host, latest]);
}

/** A slide number from what was typed ("12", "slide 12", "go to 12"), or null. */
export function slideFromQuery(query: string, total: number): number | null {
  const m = /^\s*(?:go\s*to\s*)?(?:slide|page|p\.?)?\s*#?(\d{1,5})\s*$/i.exec(query);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= total ? n : null;
}

/** A slide's number argument from a plugin: { slide } as a whole number. */
export function slideArg(args: Record<string, unknown>): number {
  const n = args.slide;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new Error('presio.goToSlide needs { slide }, a whole number');
  return n;
}

// --- Matching ---

const WORD_START = /[\s\-_/(.]/;

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** How well one typed word matches a row: by where it's found, or null. */
function wordScore(word: string, title: string, rest: string): number | null {
  const at = title.indexOf(word);
  if (at === 0) return 100;
  if (at > 0) return WORD_START.test(title[at - 1]) ? 80 : 50;
  if (rest.includes(word)) return 30;
  if (word.length > 1 && isSubsequence(word, title)) return 10;
  return null;
}

/**
 * The rows matching a query, best first: every typed word has to appear in
 * the title, the category or the keywords (or, loosely, as letters in order
 * in the title). With no query, every row in its given order.
 */
export function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const scored: { item: PaletteItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const title = item.title.toLowerCase();
    const rest = `${item.category} ${item.keywords ?? ""}`.toLowerCase();
    let score = 0;
    for (const word of words) {
      const s = wordScore(word, title, rest);
      if (s === null) return;
      score += s;
    }
    scored.push({ item, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.item);
}
