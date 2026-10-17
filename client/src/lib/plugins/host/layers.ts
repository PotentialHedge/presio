// presio.layers: positioned images a plugin puts on slides, drawn by Presio
// in every view of them (thumbnails, the next-slide preview) — the still form
// of what a "slide" surface does live. Per device.

import { asRecord } from "../manifest";
import { HostError, parseRect, type MethodTable } from "./types";

/** A static layer item: an image at a position on the page (fractions). */
export interface LayerItem {
  x: number;
  y: number;
  w: number;
  h: number;
  image: string;
  fit: "cover" | "contain";
}

/** One plugin's static layer on one slide. */
export interface PluginLayer {
  pluginId: string;
  items: LayerItem[];
}

const MAX_LAYER_ITEMS = 32;
/** An image URL a layer may show: inline, a blob, or on the web. */
const LAYER_IMAGE_RE = /^(data:image\/|blob:|https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/;
const NO_LAYERS: PluginLayer[] = [];

export class Layers {
  // Plugin id -> slide -> items, and a cache of each slide's list so reads
  // hand back a stable identity until something changes.
  private layers = new Map<string, Map<number, LayerItem[]>>();
  private cache = new Map<number, PluginLayer[]>();
  private listeners = new Set<() => void>();

  readonly methods: MethodTable = {
    "layers.set": {
      handler: (conn, p) => {
        const slide = p.slide;
        if (typeof slide !== "number" || !Number.isInteger(slide) || slide < 1 || slide > 10_000) {
          throw new HostError("InvalidParams", "layers.set needs a slide number");
        }
        const items = (Array.isArray(p.items) ? p.items : []).slice(0, MAX_LAYER_ITEMS).flatMap((raw): LayerItem[] => {
          const r = asRecord(raw);
          const rect = parseRect(r);
          if (!rect || typeof r.image !== "string" || !LAYER_IMAGE_RE.test(r.image)) return [];
          return [{ ...rect, image: r.image, fit: r.fit === "contain" ? "contain" : "cover" }];
        });
        let bySlide = this.layers.get(conn.plugin.id);
        if (!bySlide) this.layers.set(conn.plugin.id, (bySlide = new Map()));
        if (items.length) bySlide.set(slide, items);
        else bySlide.delete(slide);
        this.changed();
        return null;
      },
    },
    "layers.clear": {
      handler: (conn) => {
        if (this.layers.delete(conn.plugin.id)) this.changed();
        return null;
      },
    },
  };

  /** Every plugin's static layer on a slide; a stable array until it changes. */
  slideLayers(slide: number): PluginLayer[] {
    let cached = this.cache.get(slide);
    if (!cached) {
      cached = [];
      for (const [pluginId, bySlide] of this.layers) {
        const items = bySlide.get(slide);
        if (items?.length) cached.push({ pluginId, items });
      }
      if (!cached.length) cached = NO_LAYERS;
      this.cache.set(slide, cached);
    }
    return cached;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Forget the layers of plugins no longer running. */
  keepOnly(pluginIds: readonly string[]) {
    let changed = false;
    for (const id of [...this.layers.keys()]) {
      if (!pluginIds.includes(id)) {
        this.layers.delete(id);
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  private changed() {
    this.cache.clear();
    this.listeners.forEach((l) => l());
  }
}
