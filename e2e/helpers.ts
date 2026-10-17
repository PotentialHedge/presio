// Shared setup for the specs that drive a real controller + viewer pair.
//
// Every spec here opens one session from two separate browser contexts.
// Separate contexts share no BroadcastChannel (that is per-origin-per-profile),
// so the only path between the two windows is the server socket — which is the
// point: it means these tests exercise the full
// controller -> server -> viewer round-trip rather than a same-tab shortcut.
import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { CONTROLLER_TOKEN } from "./constants";

/** Fractional point on the slide's rendered content rect. */
export type Frac = [x: number, y: number];

/**
 * Mint a session that belongs to this test alone.
 *
 * A session carries mutable state these specs assert on — current slide,
 * drawings, timer — and Playwright runs `fullyParallel`, so a shared id
 * makes tests fail only when run together. The harness hands out a fresh one
 * per call (see server/e2eHarness.ts).
 */
export async function newSession(
  request: APIRequestContext,
  deck: "example" | "links" = "example"
): Promise<string> {
  const res = await request.post(`/__e2e/session?deck=${deck}`);
  expect(res.ok(), "harness should mint an E2E session").toBeTruthy();
  const { id } = (await res.json()) as { id: string };
  return id;
}

/**
 * Open a controller page that already owns the session.
 *
 * Ownership is proven by the token in localStorage, and the first-run tutorial
 * is marked seen so its overlay can't swallow the key presses these specs send.
 */
export async function openController(
  ctx: BrowserContext,
  sessionId: string,
  opts: { keepViewerPrompt?: boolean } = {}
): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript(
    ([id, token]) => {
      localStorage.setItem(`session_${id}`, JSON.stringify({ controllerToken: token }));
      localStorage.setItem("presio_controller_onboarded", "true");
    },
    [sessionId, CONTROLLER_TOKEN]
  );
  await page.goto(`/s/${sessionId}?role=controller`);
  if (!opts.keepViewerPrompt) await dismissViewerPrompt(page);
  return page;
}

/** Open a viewer page directly (rather than via the controller's popup). */
export async function openViewer(ctx: BrowserContext, sessionId: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`/s/${sessionId}?role=viewer`);
  return page;
}

/**
 * The controller offers to spawn a viewer window on first load. Specs that
 * bring their own viewer dismiss it; viewer-window.spec.ts is the one that
 * actually takes it up on the offer.
 */
export async function dismissViewerPrompt(controller: Page) {
  await controller
    .getByRole("button", { name: "Not now" })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

/** Wait until pdf.js has actually painted a slide into the page. */
export async function waitForSlide(page: Page) {
  await page.locator("canvas").first().waitFor({ timeout: 30_000 });
}

/** The drawing plugin's layer over the slide (a "slide" surface frame). */
export const DRAWING_FRAME = '[data-testid="plugin-frame-presio/drawing-slide"]';

/** What's inside the drawing layer: its palette, its laser dot. */
export function drawingLayer(page: Page) {
  return page.frameLocator(DRAWING_FRAME).first();
}

/**
 * The slide's *content rect* in viewport pixels: the contain-fitted page inside
 * the letterboxed canvas, which is what the drawing layer normalizes pointer
 * coordinates against. The drawing layer covers the whole slide area (bars
 * included), so the page is found as the canvas filling that area, letterboxed
 * the same way containedRect does it.
 */
export async function slideBox(page: Page) {
  const layer = page.locator(DRAWING_FRAME).first();
  await layer.waitFor({ timeout: 30_000 });
  const box = await layer.evaluate((frame) => {
    const area = frame.getBoundingClientRect();
    const canvas = [...document.querySelectorAll("canvas")].find((c) => {
      const r = c.getBoundingClientRect();
      return Math.abs(r.left - area.left) < 1 && Math.abs(r.top - area.top) < 1 && Math.abs(r.width - area.width) < 1;
    });
    if (!canvas || !canvas.width || !canvas.height) return null;
    const scale = Math.min(area.width / canvas.width, area.height / canvas.height);
    const width = canvas.width * scale;
    const height = canvas.height * scale;
    return { x: area.left + (area.width - width) / 2, y: area.top + (area.height - height) / 2, width, height };
  });
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error("slide has no layout box");
  }
  return {
    at: ([fx, fy]: Frac) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy }),
    box,
  };
}

/**
 * Pick a tool from the palette (drawn by the drawing plugin, in its frame).
 *
 * With a tool active and the pointer away, the palette collapses to just the
 * active tool, so the others have to be revealed before they can be clicked.
 * Hover reaches the palette asynchronously, so it can expand or collapse
 * between looking and clicking: retry until the tool is reachable.
 */
export async function pickTool(controller: Page, key: "none" | "laser" | "pen" | "highlighter") {
  const layer = drawingLayer(controller);
  const btn = layer.getByTestId(`tool-${key}`);
  const collapsed = layer.getByTestId("tool-collapsed");
  await expect(async () => {
    if (!(await btn.isVisible())) await collapsed.click({ timeout: 1_000 });
    await btn.click({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  // The palette may re-collapse around the new active tool, so assert on
  // whichever button is showing rather than on `btn` specifically.
  await expect(
    layer.getByTestId(`tool-${key}`).or(layer.getByTestId("tool-collapsed"))
  ).toHaveAttribute("aria-pressed", "true");
}

/**
 * Move the pointer along a path across the slide, optionally with the button
 * held (a stroke) rather than just hovering (a laser sweep).
 */
export async function trace(controller: Page, points: Frac[], draw: boolean) {
  const { at } = await slideBox(controller);
  const first = at(points[0]);
  await controller.mouse.move(first.x, first.y);
  if (draw) await controller.mouse.down();
  for (const p of points.slice(1)) {
    const { x, y } = at(p);
    await controller.mouse.move(x, y, { steps: 8 });
  }
  if (draw) await controller.mouse.up();
}

/**
 * Park the pointer above the slide. A laser dot only clears when the pointer
 * actually leaves the slide, so without this the dot sits frozen where the
 * sweep ended.
 */
export async function leaveSlide(controller: Page) {
  const { box } = await slideBox(controller);
  await controller.mouse.move(box.x + box.width / 2, Math.max(2, box.y - 40));
}

/**
 * Count pixels the drawing layer's canvases have actually painted.
 *
 * Strokes are drawn to canvases, so there is no DOM node to assert on — the
 * only honest check that a stroke arrived is that ink exists. Returns the
 * number of non-transparent pixels.
 */
export async function inkPixels(page: Page): Promise<number> {
  return page
    .locator(DRAWING_FRAME)
    .first()
    .evaluate((frame) => {
      const doc = (frame as HTMLIFrameElement).contentDocument;
      let n = 0;
      for (const c of doc?.querySelectorAll("canvas") ?? []) {
        const ctx = c.getContext("2d");
        if (!ctx || c.width === 0 || c.height === 0) continue;
        const { data } = ctx.getImageData(0, 0, c.width, c.height);
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
      }
      return n;
    });
}

/** The controller's page counter, which doubles as the jump readout. */
export function slideCounter(controller: Page) {
  return controller.getByLabel("Current page");
}

/**
 * Drive the `j<number>` jump binding: arm, type the digits, commit.
 *
 * Deliberately presses one key at a time — while a jump is armed every
 * keystroke belongs to it, and that routing is part of what is under test.
 */
export async function jumpToSlide(controller: Page, slide: number) {
  await controller.keyboard.press("j");
  await expect(slideCounter(controller)).toHaveValue("");
  for (const digit of String(slide)) await controller.keyboard.press(digit);
  await expect(slideCounter(controller)).toHaveValue(String(slide));
  await controller.keyboard.press("Enter");
}
