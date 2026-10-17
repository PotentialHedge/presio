// Controller keyboard shortcuts: types, defaults, and matching. The user's
// bindings are the "keybindings" setting (lib/settings.ts), which also holds
// their bindings for plugins' commands, as "<plugin id>.<command>" (a plugin's
// own defaults come from its manifest's contributes.keybindings).

export interface KeyBinding {
  key: string;
  meta?: boolean;
  shift?: boolean;
}

/** Whether Shift is part of a binding for this key, rather than already in the
 * character it types ("?" is Shift+/; "Z" is still "z"). */
export const shiftMatters = (key: string) => key.length !== 1 || /[a-z]/i.test(key);

export interface Keymap {
  nextSlide: KeyBinding[];
  prevSlide: KeyBinding[];
  firstSlide: KeyBinding[];
  lastSlide: KeyBinding[];
  toggleBlank: KeyBinding[];
  jumpToSlide: KeyBinding[];
  /** Plugins' commands the presenter rebound, as "<plugin id>.<command>". */
  [pluginCommand: string]: KeyBinding[];
}

export const KEYMAP_ACTIONS = ["nextSlide", "prevSlide", "firstSlide", "lastSlide", "toggleBlank", "jumpToSlide"] as const;
export type KeymapAction = (typeof KEYMAP_ACTIONS)[number];

export const KEYMAP_LABELS: Record<KeymapAction, string> = {
  nextSlide: "Next slide",
  prevSlide: "Previous slide",
  firstSlide: "First slide",
  lastSlide: "Last slide",
  toggleBlank: "Blank screen",
  jumpToSlide: "Jump to slide (then digits)",
};

export const DEFAULT_KEYMAP: Keymap = {
  // PageDown/PageUp are what presenter remotes (clickers) send for next/prev.
  nextSlide: [{ key: "ArrowRight" }, { key: " " }, { key: "PageDown" }],
  prevSlide: [{ key: "ArrowLeft" }, { key: "PageUp" }],
  firstSlide: [{ key: "ArrowLeft", meta: true }],
  lastSlide: [{ key: "ArrowRight", meta: true }],
  toggleBlank: [{ key: "b" }],
  // A prefix, not a one-shot action: it arms digit capture (see ControllerView).
  jumpToSlide: [{ key: "j" }],
};

export function matchesBinding(e: KeyboardEvent, bindings: KeyBinding[]): boolean {
  return bindings.some((b) => {
    const keyMatch = e.key.toLowerCase() === b.key.toLowerCase();
    const metaMatch = b.meta ? e.metaKey : !e.metaKey;
    const shiftMatch = !shiftMatters(b.key) || (b.shift ? e.shiftKey : !e.shiftKey);
    return keyMatch && metaMatch && shiftMatch;
  });
}

/** Where a plugin command's bindings live in the keymap. */
export const pluginCommandKey = (pluginId: string, command: string) => `${pluginId}.${command}`;

/** The keys a plugin command answers to: the presenter's, else the plugin's defaults. */
export function pluginBindings(keymap: Keymap, pluginId: string, command: { command: string; keys: KeyBinding[] }): KeyBinding[] {
  return (keymap[pluginCommandKey(pluginId, command.command)] as KeyBinding[] | undefined) ?? command.keys;
}

const sameBinding = (a: KeyBinding, b: KeyBinding) =>
  a.key.toLowerCase() === b.key.toLowerCase() && !!a.meta === !!b.meta && !!a.shift === !!b.shift;

/**
 * The Presio action already bound to this key, if any. Presio's own shortcuts
 * win, so a plugin binding that clashes never reaches the plugin.
 */
export function coreActionFor(keymap: Keymap, binding: KeyBinding): KeymapAction | null {
  return KEYMAP_ACTIONS.find((action) => keymap[action].some((b) => sameBinding(b, binding))) ?? null;
}

/** A plugin's keyboard shortcuts, as far as clashes are concerned. */
export interface PluginShortcutSet {
  id: string;
  name: string;
  keybindings: { command: string; label: string; keys: KeyBinding[] }[];
}

/**
 * What a plugin's binding clashes with, as a phrase ("Presio's “Show join
 * code”"), or null when the key is free. Presio's own shortcuts win, then
 * plugins in order, so only `earlier` plugins (the ones before it) can take
 * a key from it.
 */
export function shortcutTakenBy(keymap: Keymap, binding: KeyBinding, earlier: readonly PluginShortcutSet[]): string | null {
  if (!binding.key) return null;
  const core = coreActionFor(keymap, binding);
  if (core) return `Presio's “${KEYMAP_LABELS[core]}”`;
  for (const plugin of earlier) {
    const kb = plugin.keybindings.find((k) => pluginBindings(keymap, plugin.id, k).some((b) => sameBinding(b, binding)));
    if (kb) return `${plugin.name}'s “${kb.label}”`;
  }
  return null;
}

export function formatBinding(b: KeyBinding): string {
  const parts: string[] = [];
  if (b.shift) parts.push("⇧");
  if (b.meta) parts.push("⌘");
  const display: Record<string, string> = {
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
    " ": "Space", Escape: "Esc", Enter: "Enter",
    PageDown: "PgDn", PageUp: "PgUp",
  };
  parts.push(display[b.key] || b.key.toUpperCase());
  return parts.join("");
}
