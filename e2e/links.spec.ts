import { test, expect, type Page } from "@playwright/test";
import { newSession, openController, openViewer, pickTool, slideBox, slideCounter, waitForSlide } from "./helpers";

// Link annotations are painted into the slide bitmap by pdf.js like any other
// ink, so nothing about a rendered slide reveals whether they work — the only
// affordance is the overlay LinkOverlay puts on top. These specs run against
// e2e/fixtures/links.pdf (see scripts/make-link-fixture.mjs), a two-page deck
// whose first page carries one external and one internal link.
//
// The two link kinds answer to different rules, and the internal one differs by
// side: the controller drives the whole session, a synced viewer moves only
// itself, and a local viewer must not move at all.

/** The overlay region for the internal link (a button carrying a target slide). */
function internalLink(page: Page) {
  return page.locator('[data-testid="slide-link"][data-slide]').first();
}

/** The overlay region for the external link (an anchor, so it has an href). */
function externalLink(page: Page) {
  return page.locator('a[data-testid="slide-link"]').first();
}

test("an external link is a real hyperlink opening in a new tab", async ({ browser, request }) => {
  const sessionId = await newSession(request, "links");
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  await waitForSlide(controller);

  const link = externalLink(controller);
  await expect(link).toHaveAttribute("href", "https://example.com/");
  await expect(link).toHaveAttribute("target", "_blank");
  // Opening a tab from a deck someone else authored must not hand that tab a
  // window.opener back into the session.
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");

  await ctx.close();
});

test("an internal link moves the whole session from the controller", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request, "links");
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  const viewer = await openViewer(ctx, sessionId);
  await waitForSlide(controller);
  // The viewer must be in the room before the controller broadcasts, or it
  // simply misses the update.
  await waitForSlide(viewer);

  const viewerSlide = viewer.getByTestId("viewer-slide");
  await expect(viewerSlide).toHaveAttribute("data-slide", "1");

  await internalLink(controller).click();

  // The controller drives the session: both sides land on the target.
  await expect(slideCounter(controller)).toHaveValue("2");
  await expect(viewerSlide).toHaveAttribute("data-slide", "2");

  await ctx.close();
});

test("an internal link on a synced viewer moves that viewer alone", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request, "links");
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  const viewer = await openViewer(ctx, sessionId);
  await waitForSlide(controller);
  await waitForSlide(viewer);

  const viewerSlide = viewer.getByTestId("viewer-slide");
  await expect(viewerSlide).toHaveAttribute("data-slide", "1");

  await internalLink(viewer).click();

  // The viewer follows its own link; the controller — and so the session — is
  // untouched. This is the same independent navigation the arrow keys give a
  // synced viewer, not a broadcast.
  await expect(viewerSlide).toHaveAttribute("data-slide", "2");
  await expect(slideCounter(controller)).toHaveValue("1");

  await ctx.close();
});

test("links land on the slide they belong to and disappear with it", async ({
  browser,
  request,
}) => {
  const sessionId = await newSession(request, "links");
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  await waitForSlide(controller);

  // Both of the fixture's links live on page 1, in its top half.
  await expect(controller.getByTestId("slide-link")).toHaveCount(2);

  const slide = (await slideBox(controller)).box;
  const link = await externalLink(controller).boundingBox();
  expect(slide, "slide should have a layout box").not.toBeNull();
  expect(link, "link should have a layout box").not.toBeNull();

  // The overlay must sit on the letterboxed page, not the raw container: the
  // external link is ~7% down a page that is 468/612 wide starting ~12% in.
  const relX = (link!.x - slide!.x) / slide!.width;
  const relY = (link!.y - slide!.y) / slide!.height;
  expect(relX).toBeGreaterThan(0.08);
  expect(relX).toBeLessThan(0.16);
  expect(relY).toBeGreaterThan(0.03);
  expect(relY).toBeLessThan(0.11);

  // Page 2 carries none, so moving off page 1 must clear the overlay rather
  // than leave its regions clickable over unrelated content.
  await controller.locator("body").click();
  await controller.keyboard.press("ArrowRight");
  await expect(slideCounter(controller)).toHaveValue("2");
  await expect(controller.getByTestId("slide-link")).toHaveCount(0);

  await ctx.close();
});

test("links go inert while a drawing tool is active", async ({ browser, request }) => {
  const sessionId = await newSession(request, "links");
  const ctx = await browser.newContext();
  const controller = await openController(ctx, sessionId);
  await waitForSlide(controller);
  await expect(controller.getByTestId("slide-link")).toHaveCount(2);

  // A stroke that starts on a link must be a stroke, not a navigation: the
  // drawing layer takes all input while a tool is active, over the links.
  const internal = controller.locator('[data-testid="slide-link"][data-slide]').first();
  const box = (await internal.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const onTop = () =>
    controller.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("data-testid") ?? "", at);

  await pickTool(controller, "pen");
  await expect.poll(onTop).toBe("plugin-frame-presio/drawing-slide");

  // With no tool, clicks reach the links again.
  await pickTool(controller, "none");
  await expect.poll(onTop).toBe("slide-link");
  await controller.mouse.click(at.x, at.y);
  await expect(slideCounter(controller)).not.toHaveValue("1");

  await ctx.close();
});
