// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { Mosaic, MosaicWindow } from "react-mosaic-component";
import {
  DEFAULT_LAYOUT,
  CARD_KEYS,
  addLeaf,
  removeLeaf,
  visibleKeys,
  loadLayout,
} from "./controllerLayout";
import { STORAGE_KEYS } from "./storage";

describe("controllerLayout helpers", () => {
  it("DEFAULT_LAYOUT exposes every card, and the built-in plugins' panels, as a leaf", () => {
    expect(visibleKeys(DEFAULT_LAYOUT).sort()).toEqual([...CARD_KEYS, "plugin:presio/notes#notes", "plugin:presio/timer#timer"].sort());
  });

  it("removeLeaf drops a card and neighbours remain", () => {
    const without = removeLeaf(DEFAULT_LAYOUT, "plugin:presio/timer#timer");
    const keys = visibleKeys(without);
    expect(keys).not.toContain("plugin:presio/timer#timer");
    expect(keys).toContain("nextSlide");
    expect(keys).toHaveLength(visibleKeys(DEFAULT_LAYOUT).length - 1);
  });

  it("removeLeaf of the sole tile yields null", () => {
    expect(removeLeaf("currentSlide", "currentSlide")).toBeNull();
  });

  it("addLeaf restores a hidden card and is idempotent", () => {
    const without = removeLeaf(DEFAULT_LAYOUT, "thumbnails");
    const back = addLeaf(without, "thumbnails");
    expect(visibleKeys(back)).toContain("thumbnails");
    // Adding an already-present card is a no-op (no duplicate leaves).
    expect(visibleKeys(addLeaf(back, "thumbnails"))).toHaveLength(visibleKeys(DEFAULT_LAYOUT).length);
  });
});

// react-mosaic v7 replaced the binary tree with an n-ary one. Everyone who had
// already arranged their dashboard has a v6-shaped tree sitting in
// localStorage, and dropping it as unrecognisable would silently reset them all
// to the default — a quiet regression nothing else would catch.
describe("layouts saved by react-mosaic v6", () => {
  beforeEach(() => localStorage.clear());

  /** The binary shape v6 persisted: `first`/`second`, one `splitPercentage`. */
  const legacy = {
    direction: "row",
    first: "currentSlide",
    second: {
      direction: "column",
      first: "notes",
      second: "timer",
      splitPercentage: 40,
    },
    splitPercentage: 60,
  };

  it("are migrated on read rather than discarded", () => {
    localStorage.setItem(STORAGE_KEYS.controllerMosaic, JSON.stringify(legacy));
    const loaded = loadLayout("desktop");

    // Not the fallback — the user's own arrangement survived, with the old
    // timer and notes cards now the built-in plugins' panels.
    expect(loaded).not.toEqual(DEFAULT_LAYOUT);
    expect(visibleKeys(loaded).sort()).toEqual(["currentSlide", "plugin:presio/notes#notes", "plugin:presio/timer#timer"]);

    // And it came back in the n-ary shape the new Mosaic understands.
    expect(loaded).toMatchObject({ type: "split", direction: "row" });
  });

  it("drop cards that no longer exist, keeping the rest", () => {
    localStorage.setItem(
      STORAGE_KEYS.controllerMosaic,
      JSON.stringify({ direction: "row", first: "currentSlide", second: "retiredCard" }),
    );
    // The surviving child is promoted rather than left in a one-child split.
    expect(loadLayout("desktop")).toBe("currentSlide");
  });

  it("fall back to the default when nothing usable is stored", () => {
    localStorage.setItem(STORAGE_KEYS.controllerMosaic, JSON.stringify(["currentSlide"]));
    expect(loadLayout("desktop")).toEqual(DEFAULT_LAYOUT);
  });
});

describe("react-mosaic runtime", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  // Regression guard: react-mosaic v6 pulled a nested react-dom@18 that crashed
  // under React 19 with "ReactCurrentDispatcher is undefined" at module eval /
  // mount. v7 drops the react-dom peer dependency altogether, so the react-dom
  // override that used to dedupe the tree is gone too — a successful mount is
  // what proves the tree really does resolve a single react-dom without it.
  it("mounts a Mosaic of MosaicWindows without crashing", () => {
    const root = createRoot(host);
    act(() => {
      root.render(
        createElement(Mosaic<string>, {
          value: DEFAULT_LAYOUT,
          onChange: () => {},
          renderTile: (id, path) =>
            createElement(
              MosaicWindow<string>,
              { path, title: id },
              createElement("div", null, id),
            ),
        }),
      );
    });
    expect(host.querySelector(".mosaic")).toBeTruthy();
    act(() => root.unmount());
  });
});
