import { test, expect, type Page } from "@playwright/test";
import { jumpToSlide, newSession, openController, openViewer, waitForSlide } from "./helpers";

// Media rides along inside the PDF: the deck's sidecar attachments carry the
// bytes, and the built-in media plugin extracts them and plays each one on its
// slide as a blob URL, in its "slide" surface over the page. That whole path —
// attachment -> blob -> the right slide, in both windows — is what makes an
// animated deck work on the projector.
//
// The fixture's slide 3 holds an embedded GIF. Its other media slides point at
// YouTube, Vimeo and Wikimedia, so they are deliberately left alone: a test
// that needs the public internet is a test that fails on a bad day in CI.

/** Media the plugin extracted from the PDF, as opposed to anything remote. */
const embedded = (page: Page) =>
  page.frameLocator('[data-testid="plugin-frame-presio/media-slide"]').locator('img[src^="blob:"]');

test("media embedded in the PDF plays on the slide it belongs to, in both windows", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request);
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  const viewer = await openViewer(ctx, sessionId);
  await waitForSlide(controller);
  await waitForSlide(viewer);

  // Slide 1 carries no media.
  await expect(embedded(controller)).toHaveCount(0);
  await expect(embedded(viewer)).toHaveCount(0);

  await controller.locator("body").click();
  await jumpToSlide(controller, 3);
  await expect(viewer.getByTestId("viewer-slide")).toHaveAttribute("data-slide", "3");

  // The presenter and the room both get it.
  await expect(embedded(controller)).toHaveCount(1);
  await expect(embedded(viewer)).toHaveCount(1);

  // And it is a real decoded image, not a broken blob: a GIF that never loads
  // leaves an element in the DOM and a blank rectangle on the projector, which
  // an existence check alone would happily pass.
  for (const page of [controller, viewer]) {
    await expect
      .poll(() => embedded(page).first().evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
  }

  // Leaving the slide takes it away again.
  await controller.keyboard.press("ArrowRight");
  await expect(viewer.getByTestId("viewer-slide")).toHaveAttribute("data-slide", "4");
  await expect(embedded(controller)).toHaveCount(0);
  await expect(embedded(viewer)).toHaveCount(0);

  await ctx.close();
});
