import { useCallback, useEffect, useRef, useState } from "react";

// How long a pending "j<number>" jump waits for another digit before it
// commits on its own. Long enough to type a second digit, short enough that the
// presenter isn't left staring at a half-typed number.
const JUMP_IDLE_MS = 1200;

/**
 * "j52" style jumps: the jumpToSlide binding arms digit capture, digits
 * accumulate, and Enter or a short pause commits. The pending digits live in
 * state so the footer counter can show them — a mode that silently swallows
 * keystrokes is worse than no mode at all.
 */
export function useSlideJump(onGoTo: (slide: number) => void, totalSlides: number) {
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const jumpTimer = useRef<number | null>(null);

  const cancelJump = useCallback(() => {
    if (jumpTimer.current !== null) clearTimeout(jumpTimer.current);
    jumpTimer.current = null;
    setPendingJump(null);
  }, []);

  const commitJump = useCallback((digits: string) => {
    cancelJump();
    const n = parseInt(digits, 10);
    if (Number.isFinite(n)) onGoTo(Math.min(Math.max(n, 1), totalSlides));
  }, [cancelJump, onGoTo, totalSlides]);

  // Arm (or extend) digit capture. The idle timeout means "j5" alone still
  // jumps, and a stray prefix key never leaves the mode armed forever.
  const armJump = useCallback((digits: string) => {
    if (jumpTimer.current !== null) clearTimeout(jumpTimer.current);
    setPendingJump(digits);
    jumpTimer.current = window.setTimeout(() => {
      jumpTimer.current = null;
      if (digits) commitJump(digits);
      else cancelJump();
    }, JUMP_IDLE_MS);
  }, [commitJump, cancelJump]);

  // Never leave a pending jump's timer running past unmount.
  useEffect(() => cancelJump, [cancelJump]);

  return { pendingJump, armJump, commitJump, cancelJump };
}

export type SlideJump = ReturnType<typeof useSlideJump>;
