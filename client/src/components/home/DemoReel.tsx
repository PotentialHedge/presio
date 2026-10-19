import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";

// Mac-style chrome for the demo frames, so each recording reads as its own
// window instead of a bare video. Decorative: the dots are not controls.
function WindowFrame({
  children,
  dense = false,
  className = "",
}: {
  children: React.ReactNode;
  dense?: boolean;
  className?: string;
}) {
  const dot = dense ? "h-1.5 w-1.5" : "h-2.5 w-2.5";
  // Without an outline a near-white window disappears into a near-white page,
  // so the frame is lifted instead: a layered drop shadow in light, and in dark
  // — where a drop shadow is invisible — a faint light glow doing the same job.
  // On white it is the hairline that actually defines the edge, so that stays
  // and the ambient layers are kept barely-there — a heavy one greys the page
  // around the frame and swallows the caption underneath it.
  const elevation =
    "shadow-[0_0_0_1px_rgba(15,23,42,0.06),0_8px_24px_-4px_rgba(15,23,42,0.185),0_32px_72px_-16px_rgba(15,23,42,0.225)] " +
    "dark:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_8px_24px_-4px_rgba(0,0,0,0.75),0_32px_72px_-16px_rgba(0,0,0,0.9)]";
  return (
    <div className={`overflow-hidden rounded-xl bg-card ${elevation} ${className}`}>
      <div
        aria-hidden="true"
        className={`flex items-center gap-1.5 bg-muted/60 ${dense ? "px-2 py-1.5" : "px-3 py-2.5"}`}
      >
        <span className={`${dot} rounded-full bg-[#ff5f57]`} />
        <span className={`${dot} rounded-full bg-[#febc2e]`} />
        <span className={`${dot} rounded-full bg-[#28c840]`} />
      </div>
      {children}
    </div>
  );
}

// Tailwind's md breakpoint, read from JS: the parallax has to know whether the
// two windows are overlapping or stacked, and only CSS knows that otherwise.
// Keep in step with the md: classes on the inset in DemoReel.
const OVERLAP_QUERY = "(min-width: 768px)";

// Drift for the front window as the page scrolls: nearer things travel further,
// so the inset rises a little faster than the frame behind it. Capped, because
// past the hero the effect has nothing left to say. Returns 0 under
// prefers-reduced-motion — parallax is exactly the motion that setting is about.
function useParallax(enabled: boolean, factor = 0.1, max = 110) {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      setOffset(-Math.min(window.scrollY * factor, max));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled, factor, max]);
  return offset;
}

// Hero demo reel: two recordings of one session, the presenter's controller and
// the audience's viewer, captured together and replayed overlaid. Autoplays
// muted and loops, which is what a silent screen recording wants. It plays
// under prefers-reduced-motion too, by request — the scroll parallax still
// honours that setting, but the reel itself is the page's main content.
//
// The clips are trimmed to a shared origin at record time, so they start
// aligned; this only has to correct the drift that accumulates from two
// independent decoders. The controller is the clock and the viewer chases it.
export function DemoReel() {
  const controllerRef = useRef<HTMLVideoElement | null>(null);
  const viewerRef = useRef<HTMLVideoElement | null>(null);
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Each theme has its own pair of recordings. Swapping src reloads the video
  // from zero, so the position is carried across the switch.
  const theme = useResolvedTheme();
  const overlapping = useMediaQuery(OVERLAP_QUERY);
  const parallax = useParallax(!reducedMotion && overlapping);
  const resumeAt = useRef(0);
  const resume = (el: HTMLVideoElement) => {
    if (resumeAt.current > 0 && resumeAt.current < el.duration) {
      el.currentTime = resumeAt.current;
    }
  };

  useEffect(() => {
    const lead = controllerRef.current;
    const follow = viewerRef.current;
    if (!lead || !follow) return;

    // A seek mid-frame is visible, so only correct once the gap is worse than
    // the seam it would cause. The loop wrap is not drift — skip it.
    const DRIFT_S = 0.2;
    const resync = () => {
      resumeAt.current = lead.currentTime;
      if (follow.readyState < 1 || follow.seeking) return;
      const gap = lead.currentTime - follow.currentTime;
      if (Math.abs(gap) > DRIFT_S && Math.abs(gap) < lead.duration / 2) {
        follow.currentTime = lead.currentTime;
      }
    };

    const play = () => void follow.play().catch(() => { });
    const pause = () => follow.pause();

    lead.addEventListener("timeupdate", resync);
    lead.addEventListener("play", play);
    lead.addEventListener("pause", pause);
    lead.addEventListener("seeked", resync);
    return () => {
      lead.removeEventListener("timeupdate", resync);
      lead.removeEventListener("play", play);
      lead.removeEventListener("pause", pause);
      lead.removeEventListener("seeked", resync);
    };
  }, []);

  const shared = {
    preload: "auto" as const,
    autoPlay: true,
    loop: true,
    muted: true,
    playsInline: true,
  };

  return (
    // Held a little back from full strength: the reel is supporting material
    // next to the headline and the drop zone, not competing with them.
    <div className="relative mx-auto w-full max-w-115 opacity-85 md:mx-0 md:max-w-none">
      <span className="mb-3 block text-center font-mono text-xs font-semibold uppercase tracking-wide text-[var(--home2-accent)] sm:text-left">
        How it works:
      </span>

      {/* Presenter's controller: the deck, next slide, notes and timer. */}
      <span className="mb-2 block text-center text-xs font-medium text-foreground/70 sm:text-left">
        Browser Window 1
      </span>
      <WindowFrame>
        <video
          {...shared}
          ref={controllerRef}
          width={1280}
          height={800}
          className="block h-auto w-full"
          poster={`/demo-controller-${theme}-poster.jpg`}
          src={`/demo-controller-${theme}.mp4`}
          onLoadedMetadata={(e) => resume(e.currentTarget)}
          aria-label="Screen recording: the Presio controller, showing the current slide, the next slide, speaker notes and a running timer while the presenter moves through a deck."
        />
      </WindowFrame>

      {/* What the audience sees, hung off the bottom-right corner so it clips
          the controller rather than covering it. Below md the hero is a single
          column, so it stacks underneath instead. While the grid still spans
          the viewport the window can only just clear the edge; from xl up there
          is spare gutter beside the max-w-6xl grid to drift out into. */}
      <div
        className="mt-4 md:absolute md:mt-0 md:-bottom-8 md:right-0 md:w-[58%] lg:-bottom-10 lg:-right-2 lg:w-[56%] xl:-bottom-14 xl:-right-12 2xl:-right-28 min-[1800px]:-right-44"
        style={parallax ? { transform: `translate3d(0, ${parallax}px, 0)`, willChange: "transform" } : undefined}
      >
        <WindowFrame dense className="md:ring-4 md:ring-background dark:md:ring-0">
          <video
            {...shared}
            ref={viewerRef}
            width={1280}
            height={720}
            className="block h-auto w-full"
            poster={`/demo-viewer-${theme}-poster.jpg`}
            src={`/demo-viewer-${theme}.mp4`}
            onLoadedMetadata={(e) => resume(e.currentTarget)}
            aria-hidden="true"
            tabIndex={-1}
          />
        </WindowFrame>
        {/* Sits over the frame's shadow, so it needs more contrast than the
            muted grey the rest of the page uses for captions. */}
        <span className="relative mt-2.5 block text-center text-xs font-medium text-foreground/70 sm:text-left">
          Browser Window 2
        </span>
      </div>
    </div>
  );
}
