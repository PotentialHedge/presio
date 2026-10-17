// The presenter's hidden surface: posters for every slide's media (so Next
// Slide and the thumbnails show them), autoplay on arriving at a slide, the
// keyboard shortcuts, and baking media into a downloaded PDF.

import { isPlayable, readPlacements, release, type Placement, type Placements } from "./placements";
import { poster } from "./posters";
import { parseState, parseTime, sendState, type MediaState, type TimeMessage } from "./protocol";

// How long a time sample says whether an item is playing.
const SAMPLE_FRESH_MS = 2000;

export function runBackground() {
  let placements: Placements = new Map();
  let loaded = false;
  let state: MediaState | null = null;
  let lastTime: (TimeMessage & { at: number }) | null = null;

  presio.messages.onMessage(({ type, payload }) => {
    if (type === "state") state = parseState(payload) ?? state;
    else if (type === "time") {
      const time = parseTime(payload);
      if (time) lastTime = { ...time, at: Date.now() };
    }
  });

  const onSlide = () => placements.get(presio.slide.current) ?? [];

  // A new slide starts with its autoplay item playing (on every screen, in
  // time with this one), or with nothing.
  const enterSlide = () => {
    const auto = onSlide().find((p) => p.autoplay);
    state = sendState(presio.slide.current, auto?.id ?? null, auto ? "play" : "pause", state);
  };

  const load = async () => {
    let next: Placements;
    try {
      next = await readPlacements();
    } catch {
      return;
    }
    release(placements);
    placements = next;
    presio.layers.clear();
    for (const [slide, list] of placements) {
      void Promise.all(list.map(async (p) => ({ p, image: await poster(p) }))).then((posters) => {
        if (placements !== next) return;
        presio.layers.set(
          slide,
          posters.flatMap(({ p, image }) => (image ? [{ x: p.x, y: p.y, w: p.w, h: p.h, image, fit: "cover" as const }] : []))
        );
      });
    }
    // Opening (or reloading) the deck counts as arriving at its slide, unless
    // the session already holds a command for it.
    if (!loaded && state?.slide !== presio.slide.current) enterSlide();
    loaded = true;
  };

  presio.slide.onChange(() => {
    if (loaded) enterSlide();
  });
  presio.deck.onChange(load);
  void load();

  // The item a shortcut acts on: the one last used on this slide, else the first.
  const target = (candidates: Placement[]): Placement | undefined =>
    (state?.slide === presio.slide.current && candidates.find((p) => p.id === state!.id)) || candidates[0];

  const isPlaying = (p: Placement) => {
    const slide = presio.slide.current;
    if (lastTime && lastTime.slide === slide && lastTime.id === p.id && Date.now() - lastTime.at < SAMPLE_FRESH_MS) {
      return lastTime.playing;
    }
    return state?.slide === slide && state.id === p.id && state.action === "play";
  };

  presio.commands.register("togglePlay", () => {
    const p = target(onSlide().filter(isPlayable));
    if (p) state = sendState(presio.slide.current, p.id, isPlaying(p) ? "pause" : "play", state);
  });

  presio.commands.register("restart", () => {
    const p = target(onSlide());
    if (p) state = sendState(presio.slide.current, p.id, "reset", state);
  });

  // pdf-lib only loads when a download asks for it.
  presio.deck.onExport(async (bytes) => (await import("./bake")).bakeMedia(bytes, placements));
}
