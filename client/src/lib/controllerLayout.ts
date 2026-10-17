// Controller dashboard card layout: configuration + persistence.
//
// The controller is a tiling window manager (react-mosaic) of cards: current
// slide, next slide, thumbnails, and plugins' panels. Cards always tile to fill the
// screen, so removing or resizing one makes its neighbours grow rather than
// leaving a hole. The layout is a tree (`MosaicNode`); a card is visible iff it
// appears as a leaf in that tree. This module owns the card catalog, the
// default tree, and the localStorage load/sanitize/save logic so the view
// component only deals with React state.
//
// react-mosaic v7 replaced the binary tree with an n-ary one: a parent is now
// `{ type: "split", direction, children[], splitPercentages[] }` rather than
// `{ direction, first, second, splitPercentage }`, paths are numeric indices
// instead of "first"/"second", and a parent can also be a tabs node. Layouts
// persisted by earlier versions are still in the binary shape, so sanitize()
// converts them on read — see legacy handling there.

import {
  getLeaves,
  createRemoveUpdate,
  updateTree,
  convertLegacyToNary,
  isSplitNode,
  isTabsNode,
} from "react-mosaic-component";
import type { MosaicNode, MosaicPath } from "react-mosaic-component";
import { lsGet, lsSet, STORAGE_KEYS } from "./storage";
import { PLUGIN_ID_RE } from "@shared/plugin/sources";

interface CardConfig {
  key: string;
  label: string;
}

const CARD_CONFIGS: CardConfig[] = [
  { key: "currentSlide", label: "Current Slide" },
  { key: "nextSlide", label: "Next Slide" },
  { key: "thumbnails", label: "Thumbnails" },
];

export const CARD_KEYS = CARD_CONFIGS.map((c) => c.key);
export const CARD_LABELS: Record<string, string> = Object.fromEntries(
  CARD_CONFIGS.map((c) => [c.key, c.label]),
);

/** Each panel a plugin contributes gets a card of its own, keyed by plugin id
 *  and panel. Switching a plugin on adds its panels; only built-ins that used
 *  to be cards (the timer, speaker notes) are in the default layouts, where
 *  they were. */
export const pluginPanelKey = (pluginId: string, panel: string) => `plugin:${pluginId}#${panel}`;
const TIMER_TILE = pluginPanelKey("presio/timer", "timer");
const NOTES_TILE = pluginPanelKey("presio/notes", "notes");
const PLUGIN_PANEL_RE = /^plugin:(.+)#[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Whether a leaf can be a card: a built-in one, or a plugin's. Saved layouts
 *  keep plugin tiles even while that plugin isn't running (see restrictLayout). */
function isCardKey(key: string): boolean {
  const panel = PLUGIN_PANEL_RE.exec(key);
  return CARD_KEYS.includes(key) || (!!panel && PLUGIN_ID_RE.test(panel[1]));
}

/** Which form factor a layout belongs to. The phone and the desktop keep
 *  separate trees (and separate defaults): the same arrangement can't serve
 *  both, and a card moved on one shouldn't move on the other. */
export type LayoutForm = "desktop" | "mobile" | "mobileLandscape";

/** Default arrangement, mirroring the previous grid: current slide on the left,
 *  next slide + timer stacked over speaker notes on the right, thumbnails as a
 *  full-width strip along the bottom. `splitPercentages` gives each child's
 *  share in order, and must sum to 100. */
export const DEFAULT_LAYOUT: MosaicNode<string> = {
  type: "split",
  direction: "column",
  children: [
    {
      type: "split",
      direction: "row",
      children: [
        "currentSlide",
        {
          type: "split",
          direction: "column",
          children: [
            {
              type: "split",
              direction: "row",
              children: ["nextSlide", TIMER_TILE],
              splitPercentages: [65, 35],
            },
            NOTES_TILE,
          ],
          splitPercentages: [62, 38],
        },
      ],
      splitPercentages: [52, 48],
    },
    "thumbnails",
  ],
  splitPercentages: [68, 32],
};

/** Phone default: one column, current slide taking most of it, with the next
 *  slide and the speaker notes below. Same cards and same dashboard as the
 *  desktop — only the arrangement differs, so everything else (hiding a card,
 *  the Settings checkboxes, resizing) works identically on a phone. */
export const MOBILE_LAYOUT: MosaicNode<string> = {
  type: "split",
  direction: "column",
  children: ["currentSlide", "nextSlide", NOTES_TILE],
  splitPercentages: [56, 26, 18],
};

/** The same idea sideways: a phone in landscape has no vertical room for three
 *  stacked cards, so the slide takes the left and its two companions share a
 *  narrow column on the right. */
export const MOBILE_LANDSCAPE_LAYOUT: MosaicNode<string> = {
  type: "split",
  direction: "row",
  children: [
    "currentSlide",
    {
      type: "split",
      direction: "column",
      children: ["nextSlide", NOTES_TILE],
      splitPercentages: [55, 45],
    },
  ],
  splitPercentages: [64, 36],
};

/** The arrangements offered by name in Settings. They are the per-form
 *  defaults, so picking one is the same as starting fresh on that kind of
 *  screen — a phone can be given the desktop grid, and a laptop the stacked
 *  phone column, without either becoming the default for the other. */
export const LAYOUT_PRESETS: { form: LayoutForm; label: string; hint: string }[] = [
  { form: "desktop", label: "Desktop", hint: "Slide left, next/timer/notes right, thumbnails below" },
  { form: "mobile", label: "Phone", hint: "One column: slide, next slide, notes" },
  { form: "mobileLandscape", label: "Phone landscape", hint: "Slide left, next slide over notes right" },
];

const STORAGE_KEY: Record<LayoutForm, string> = {
  desktop: STORAGE_KEYS.controllerMosaic,
  mobile: STORAGE_KEYS.controllerMosaicMobile,
  mobileLandscape: STORAGE_KEYS.controllerMosaicMobileLandscape,
};

const DEFAULTS: Record<LayoutForm, MosaicNode<string>> = {
  desktop: DEFAULT_LAYOUT,
  mobile: MOBILE_LAYOUT,
  mobileLandscape: MOBILE_LANDSCAPE_LAYOUT,
};

export function defaultLayout(form: LayoutForm): MosaicNode<string> {
  return DEFAULTS[form];
}

/**
 * A layout persisted by react-mosaic v6 or earlier: a binary parent with
 * `first`/`second` rather than `children`.
 *
 * These are still sitting in users' localStorage, so they have to be recognised
 * and converted rather than discarded — dropping them would silently reset
 * every existing user's dashboard to the default.
 */
function isLegacyParent(node: unknown): boolean {
  return (
    typeof node === "object" &&
    node !== null &&
    "direction" in node &&
    "first" in node &&
    "second" in node
  );
}

/** Project an untrusted parsed value onto the known cards. Unknown leaves are
 *  dropped, containers left with too few children collapse into what survives,
 *  and anything unrecognisable (e.g. the much older array format) yields null
 *  so the caller can fall back to the default. */
function sanitize(node: unknown): MosaicNode<string> | null {
  // Migrate a v6 tree before validating it, so the rest of this function only
  // ever deals with the n-ary shape.
  const value = isLegacyParent(node)
    ? convertLegacyToNary(node as MosaicNode<string>)
    : (node as MosaicNode<string> | null);

  return prune(renameLeaf(renameLeaf(value, "timer", TIMER_TILE), "notes", NOTES_TILE), isCardKey);
}

/** The same tree with one card key replaced: the timer and notes cards became
 *  plugins' tiles, and a saved layout should keep them where they were. */
function renameLeaf(node: MosaicNode<string> | null, from: string, to: string): MosaicNode<string> | null {
  if (typeof node === "string") return node === from ? to : node;
  if (isSplitNode(node)) return { ...node, children: node.children.map((c) => renameLeaf(c, from, to)!) };
  if (isTabsNode(node)) return { ...node, tabs: node.tabs.map((t) => (t === from ? to : t)) };
  return node;
}

/**
 * The saved layout narrowed to the cards that can render right now: a plugin
 * panel stays in the stored tree while its plugin is off or still loading, but
 * the dashboard can't draw it. Nothing is saved from here.
 */
export function restrictLayout(
  node: MosaicNode<string> | null,
  available: readonly string[],
): MosaicNode<string> | null {
  return prune(node, (key) => available.includes(key));
}

/**
 * Drop everything that isn't a known card, collapsing containers that no longer
 * hold enough children to be worth keeping.
 *
 * Bottom-up, so a split whose children all collapse away collapses in turn.
 * (v7 ships normalizeMosaicTree for this, but does not re-export it from the
 * package index.)
 */
function prune(
  node: MosaicNode<string> | null | undefined,
  keep: (key: string) => boolean,
): MosaicNode<string> | null {
  if (typeof node === "string") return keep(node) ? node : null;
  if (node == null) return null;

  if (isSplitNode(node)) {
    // Keep each surviving child's share by pruning both arrays in step;
    // normalizeMosaicTree collapses a split left with a single child.
    const kept: MosaicNode<string>[] = [];
    const shares: number[] = [];
    node.children.forEach((child, i) => {
      const pruned = prune(child, keep);
      if (pruned == null) return;
      kept.push(pruned);
      shares.push(node.splitPercentages?.[i] ?? 100 / node.children.length);
    });
    if (kept.length === 0) return null;
    // A split with one child is just that child.
    if (kept.length === 1) return kept[0];
    return {
      type: "split",
      direction: node.direction === "column" ? "column" : "row",
      children: kept,
      splitPercentages: rescale(shares),
    };
  }

  if (isTabsNode(node)) {
    const tabs = node.tabs.filter(keep);
    if (tabs.length === 0) return null;
    // A tab strip needs at least two tabs; one is just the card itself.
    if (tabs.length === 1) return tabs[0];
    return {
      type: "tabs",
      tabs,
      // The active tab may have been one of the dropped ones.
      activeTabIndex: Math.min(Math.max(node.activeTabIndex ?? 0, 0), tabs.length - 1),
    };
  }

  return null;
}

/** Split shares must sum to 100, which pruning a child breaks. */
function rescale(shares: number[]): number[] {
  const total = shares.reduce((a, b) => a + b, 0);
  if (total <= 0) return shares.map(() => 100 / shares.length);
  return shares.map((s) => (s / total) * 100);
}

/** Keys currently shown as tiles, in the tree's canonical order. */
export function visibleKeys(node: MosaicNode<string> | null): string[] {
  return getLeaves(node).filter(isCardKey);
}

/** Path to a card, as the numeric child indices v7 addresses nodes by. */
function findPath(
  node: MosaicNode<string> | null,
  key: string,
  path: MosaicPath = [],
): MosaicPath | null {
  if (node == null) return null;
  if (typeof node === "string") return node === key ? path : null;

  if (isSplitNode(node)) {
    for (let i = 0; i < node.children.length; i++) {
      const found = findPath(node.children[i], key, [...path, i]);
      if (found) return found;
    }
    return null;
  }

  if (isTabsNode(node)) {
    const i = node.tabs.indexOf(key);
    return i === -1 ? null : [...path, i];
  }

  return null;
}

/** Add a card as a new full-height column on the right edge. No-op if already
 *  present or the key is unknown. */
export function addLeaf(node: MosaicNode<string> | null, key: string): MosaicNode<string> {
  if (!isCardKey(key)) return node ?? key;
  if (node == null) return key;
  if (findPath(node, key)) return node;
  return {
    type: "split",
    direction: "row",
    children: [node, key],
    splitPercentages: [75, 25],
  };
}

/** Remove a card from the tree; neighbours expand to fill the space. Returns
 *  null if the removed card was the last one. */
export function removeLeaf(
  node: MosaicNode<string> | null,
  key: string,
): MosaicNode<string> | null {
  const path = findPath(node, key);
  if (node == null || path == null) return node;
  if (path.length === 0) return null; // removing the sole remaining tile
  return updateTree(node, [createRemoveUpdate(node, path)]);
}

export function loadLayout(form: LayoutForm): MosaicNode<string> {
  return sanitize(lsGet(STORAGE_KEY[form], null)) ?? defaultLayout(form);
}

export function saveLayout(form: LayoutForm, node: MosaicNode<string> | null) {
  lsSet(STORAGE_KEY[form], node);
}

export function savePreferred(node: MosaicNode<string> | null) {
  lsSet(STORAGE_KEYS.preferredMosaic, node);
}

export function hasPreferredLayout(): boolean {
  return sanitize(lsGet(STORAGE_KEYS.preferredMosaic, null)) !== null;
}

/** Load the user's saved "preferred" layout, or null if none is stored. */
export function loadPreferred(): MosaicNode<string> | null {
  return sanitize(lsGet(STORAGE_KEYS.preferredMosaic, null));
}
