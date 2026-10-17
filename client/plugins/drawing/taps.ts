// A double-tap with two fingers together on the slide: undo (from Tristan
// Gabl's Apple Pencil work, #125). One finger's taps are never the drawing's:
// they turn the page, at once.
//
// Watched in the capture phase, so touches Presio takes for pinching still
// count. Taps with the pen down, or just after it (a resting palm), never do,
// and taps on the palette are the palette's.

// A tap: released quickly, barely moved.
const MAX_TWO_FINGER_TAP_MS = 350;
const MAX_TAP_SLOP_PX = 12;
// The most time between one tap's release and the next one's touch.
const DOUBLE_TAP_MS = 350;

export function watchTaps(opts: {
  /** Whether a two-finger double-tap counts now. */
  twoFinger: () => boolean;
  onTwoFingerDoubleTap: () => void;
  /** Taps here are someone else's (the palette). */
  ignore: (target: EventTarget | null) => boolean;
}) {
  const touches = new Map<number, { x: number; y: number }>();
  let penDown = 0;
  // The current touch group: from the first finger down until all are up.
  let group: { t: number; max: number; moved: boolean } | null = null;
  let lastTwoTap: number | null = null;

  window.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "pen") {
        // A group that the pen touches down during is a resting palm.
        if (group) group.moved = true;
        penDown++;
        return;
      }
      if (e.pointerType !== "touch" || opts.ignore(e.target)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!group) group = { t: performance.now(), max: 0, moved: penDown > 0 };
      group.max = Math.max(group.max, touches.size);
    },
    true
  );

  const up = (e: PointerEvent) => {
    if (e.pointerType === "pen") {
      penDown = Math.max(0, penDown - 1);
      return;
    }
    const start = touches.get(e.pointerId);
    if (!start) return;
    touches.delete(e.pointerId);
    if (e.type === "pointercancel") {
      if (!touches.size) group = null;
      lastTwoTap = null;
      return;
    }
    if (group && Math.hypot(e.clientX - start.x, e.clientY - start.y) > MAX_TAP_SLOP_PX) group.moved = true;
    if (touches.size || !group) return;
    // The last finger of a group lifted: was it a clean two-finger tap?
    const g = group;
    group = null;
    const now = performance.now();
    const twoTap = g.max === 2 && !g.moved && penDown === 0 && now - g.t <= MAX_TWO_FINGER_TAP_MS && opts.twoFinger();
    if (!twoTap) lastTwoTap = null;
    else if (lastTwoTap !== null && g.t - lastTwoTap <= DOUBLE_TAP_MS) {
      lastTwoTap = null;
      opts.onTwoFingerDoubleTap();
    } else lastTwoTap = now;
  };
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
}
