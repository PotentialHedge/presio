// The presenter's hidden surface: a still of each slide's drawing for Next
// Slide and the thumbnails, the keyboard shortcuts and the buttons (the
// header's, and saving or loading the drawing from its Settings page), and
// baking the drawing into a downloaded PDF. It reads the same history as the
// slide surface (see model.ts).

import { clearOps, commitAll, drawnSlides, loadOps, openDrawing, parseFile, redoOps, serializeFile, strokes, undoOps, type DrawingState, type Tool } from "./model";
import { drawStrokes } from "./render";
import { saveFile } from "../../src/lib/saveFile";

// How wide previews are drawn, and how long a slide's drawing has to settle
// before its preview is redrawn — a preview per stroke would be wasted work.
const PREVIEW_WIDTH = 640;
const PREVIEW_DELAY_MS = 250;

export function runBackground() {
  const history = openDrawing();
  let pages: { width: number; height: number }[] = [];
  const previews = new Map<number, string>();
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  // Saving to a file needs something drawn.
  const showSaveFile = () => presio.ui.setButton("saveFile", { disabled: drawnSlides(history.state).length === 0 });

  // --- Previews (presio.layers) ---

  // Hidden drawings (the palette's eye) are hidden here too.
  const isHidden = () => presio.settings.get("hidden") === true;
  const showPreview = (slide: number) => {
    const url = previews.get(slide);
    presio.layers.set(slide, url && !isHidden() ? [{ x: 0, y: 0, w: 1, h: 1, image: url, fit: "cover" }] : []);
  };
  let hidden = isHidden();
  presio.settings.onChange(() => {
    if (isHidden() === hidden) return;
    hidden = isHidden();
    for (const slide of previews.keys()) showPreview(slide);
  });

  const preview = async (slide: number) => {
    pending.delete(slide);
    const list = strokes(history.state, slide);
    const old = previews.get(slide);
    if (!list.length) {
      presio.layers.set(slide, []);
      previews.delete(slide);
    } else {
      const size = pages[slide - 1] ?? pages[0] ?? { width: 16, height: 9 };
      const canvas = document.createElement("canvas");
      canvas.width = PREVIEW_WIDTH;
      canvas.height = Math.max(1, Math.round((PREVIEW_WIDTH * size.height) / size.width));
      drawStrokes(canvas.getContext("2d")!, list, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
      if (!blob || strokes(history.state, slide) !== list) return;
      const url = URL.createObjectURL(blob);
      previews.set(slide, url);
      showPreview(slide);
    }
    if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  };

  const schedulePreview = (slide: number) => {
    clearTimeout(pending.get(slide));
    pending.set(slide, setTimeout(() => void preview(slide), PREVIEW_DELAY_MS));
  };

  // Redraw the previews of the slides whose strokes changed.
  let shown: DrawingState = history.state;
  history.onChange((state) => {
    const prev = shown;
    shown = state;
    for (const slide of new Set([...prev.slides.keys(), ...state.slides.keys()])) {
      if (strokes(prev, slide) !== strokes(state, slide)) schedulePreview(slide);
    }
    showSaveFile();
  });

  const loadPages = async () => {
    pages = await presio.deck.pages().catch(() => pages);
    for (const slide of drawnSlides(history.state)) schedulePreview(slide);
  };
  // A replaced deck keeps its drawing when its page count is the same (a
  // recompile); otherwise its history starts over, and the change says so.
  presio.deck.onChange((kind) => {
    if (kind === "replace") {
      presio.layers.clear();
      for (const url of previews.values()) URL.revokeObjectURL(url);
      previews.clear();
    }
    void loadPages();
  });
  void loadPages();

  // --- Tools, from the keyboard ---

  // The tool is this device's, shared with the slide surface through storage.
  // A reload starts with none, so the slide takes clicks again.
  presio.storage.set("tool", "none");
  const setTool = (tool: Tool) => {
    if (tool !== "none" && presio.settings.get("toolbar") === false) void presio.settings.set("toolbar", true);
    presio.storage.set("tool", tool);
  };
  presio.commands.register("pen", () => setTool("pen"));
  presio.commands.register("highlighter", () => setTool("highlighter"));
  presio.commands.register("laser", () => setTool("laser"));
  presio.commands.register("pointer", () => setTool("none"));
  // The eraser and the lasso are advanced tools: asking for one shows them.
  const setAdvancedTool = (tool: Tool) => {
    if (presio.settings.get("advanced") !== true) void presio.settings.set("advanced", true);
    setTool(tool);
  };
  presio.commands.register("eraser", () => setAdvancedTool("eraser"));
  presio.commands.register("lasso", () => setAdvancedTool("lasso"));
  presio.commands.register("redo", () => { commitAll(history, redoOps(history, presio.slide.current)); });
  presio.commands.register("toggleDrawings", () => void presio.settings.set("hidden", presio.settings.get("hidden") !== true));
  presio.commands.register("undo", () => { commitAll(history, undoOps(history, presio.slide.current)); });
  presio.commands.register("clear", () => { commitAll(history, clearOps(history.state, presio.slide.current)); });

  // --- The palette's button in the current slide's header (its command) ---

  const showButton = () => presio.ui.setButton("palette", { active: presio.settings.get("toolbar") !== false });
  presio.commands.register("palette", () => void presio.settings.set("toolbar", presio.settings.get("toolbar") === false));
  presio.settings.onChange(showButton);
  showButton();

  // --- Saving and loading, from its page in Settings ---

  presio.commands.register("saveFile", () => {
    saveFile(new Blob([serializeFile(history.state)], { type: "application/json" }), "slides-drawing.json");
  });
  presio.commands.register("loadFile", (args) => {
    const file = args?.file;
    if (!file) return;
    try {
      const loaded = parseFile(new TextDecoder().decode(file.bytes), presio.slide.total);
      commitAll(history, loadOps(history.state, loaded));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to load the drawing");
    }
  });
  showSaveFile();

  // pdf-lib only loads when a download asks for it.
  presio.deck.onExport(async (bytes) => (await import("./bake")).bakeDrawing(bytes, (await history.whenReady()).state));
}
