import { test, expect } from "@playwright/test";
import { drawingLayer, newSession, openController, openViewer, slideBox, waitForSlide } from "./helpers";

// The controller is a presenter's dashboard, not just a remote: notes to read
// from, a clock to pace against, and two keys that take over the room's screen.
// Each of these either shows something only the presenter sees, or changes what
// the audience sees — so each is worth its own assertion.

test("speaker notes follow the deck and come from the PDF's own attachments", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  await waitForSlide(controller);

  // Notes are a built-in plugin: its card is a sandboxed frame.
  const tile = controller.frameLocator('[data-testid="plugin-frame-presio/notes-panel-notes"]');
  const notes = tile.getByTestId("speaker-notes");

  // The fixture deck carries notes on slides 2 and 3 only, so slide 1 offers
  // the empty-state instead of a notes body.
  await expect(tile.getByText("Click to add speaker notes.")).toBeVisible();
  await expect(notes).toHaveCount(0);

  await controller.locator("body").click();
  await controller.keyboard.press("ArrowRight");

  // Slide 2's sidecar has two notes blocks, which are concatenated into one.
  await expect(notes).toContainText("Remember to introduce yourself");
  await expect(notes).toContainText("should be concatenated");

  await controller.keyboard.press("ArrowRight");
  await expect(notes).toContainText("This GIF is embedded directly in the PDF.");

  // Notes are the presenter's alone — they must never reach the projector.
  const viewer = await openViewer(ctx, sessionId);
  await waitForSlide(viewer);
  await expect(viewer.locator('[data-testid^="plugin-frame-presio/notes"]')).toHaveCount(0);
  await expect(viewer.getByText("This GIF is embedded directly")).toHaveCount(0);

  await ctx.close();
});

test("the talk timer starts, counts, and resets", async ({ browser, request }) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  await waitForSlide(controller);

  // The timer is a built-in plugin: its card is a sandboxed frame.
  const tile = controller.frameLocator('[data-testid="plugin-frame-presio/timer-panel-timer"]');
  const elapsed = tile.getByTestId("timer-elapsed");
  await expect(elapsed).toHaveText("00:00");

  await tile.getByRole("button", { name: "Start", exact: true }).click();

  // Running, not just relabelled: the readout has to actually move.
  await expect(elapsed).not.toHaveText("00:00", { timeout: 5_000 });
  await expect(tile.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

  await tile.getByRole("button", { name: "Stop", exact: true }).click();
  const stopped = await elapsed.textContent();

  // Stopped means stopped — the clock must hold where it was left.
  await controller.waitForTimeout(1500);
  await expect(elapsed).toHaveText(stopped ?? "");

  await tile.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(elapsed).toHaveText("00:00");

  await ctx.close();
});

test("blanking the screen takes over the viewer and releases it again", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  const viewer = await openViewer(ctx, sessionId);
  await waitForSlide(controller);
  await waitForSlide(viewer);

  const blanked = viewer.getByText("Screen blanked by presenter");
  await expect(blanked).toBeHidden();

  // "b" is the key you hit when the room should be looking at you instead.
  await controller.locator("body").click();
  await controller.keyboard.press("b");
  await expect(blanked).toBeVisible();

  await controller.keyboard.press("b");
  await expect(blanked).toBeHidden();

  await ctx.close();
});

test("the join code can be thrown up on the viewer", async ({ browser, request }) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  const viewer = await openViewer(ctx, sessionId);
  await waitForSlide(controller);
  await waitForSlide(viewer);

  // The built-in Join Code plugin's layer, mounted on every viewer but hidden
  // until the presenter puts it up.
  const layer = viewer.getByTestId("plugin-frame-presio/join-code-viewer");
  await expect(layer).toBeAttached();
  await expect(layer).toBeHidden();

  await controller.locator("body").click();
  await controller.keyboard.press("c");

  // The projector shows the code itself, so the room can type it in.
  await expect(layer).toBeVisible();
  await expect(viewer.frameLocator('[data-testid="plugin-frame-presio/join-code-viewer"]').getByText(sessionId, { exact: true })).toBeVisible();

  await controller.keyboard.press("c");
  await expect(layer).toBeHidden();

  await ctx.close();
});

test("the drawing palette collapses to the active tool and reopens", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  await waitForSlide(controller);

  // All four tools are offered while the palette is expanded. It's the
  // built-in drawing plugin's, drawn in its layer over the slide.
  const palette = drawingLayer(controller);
  for (const key of ["none", "laser", "pen", "highlighter"]) {
    await expect(palette.getByTestId(`tool-${key}`)).toBeVisible();
  }

  // Picking one and moving the pointer away collapses the palette to just that
  // tool, so it stops covering the slide mid-talk.
  await palette.getByTestId("tool-pen").click();
  const { box } = await slideBox(controller);
  await controller.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });

  const collapsed = palette.getByTestId("tool-collapsed");
  await expect(collapsed).toBeVisible();
  await expect(palette.getByTestId("tool-laser")).toBeHidden();

  // And it reopens on demand — under the mouse, or at a tap (a touch screen
  // has no hover) — with the pen still the active tool.
  await collapsed.dispatchEvent("click");
  await expect(palette.getByTestId("tool-pen")).toHaveAttribute("aria-pressed", "true");
  await expect(palette.getByTestId("tool-laser")).toBeVisible();

  await ctx.close();
});
