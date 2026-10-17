import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate, Link } from "react-router-dom";
import { openPdf, destroyPdf } from "@/lib/pdf";
import { ExternalLink, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AccountControl } from "@/components/AccountControl";
import { PresioLogo } from "@/components/PresioLogo";
import { GitHubIcon } from "@/components/GitHubIcon";
import { MobileNotice } from "@/components/MobileNotice";
import { CodeBlock } from "@/components/CodeBlock";
import { CopyAgentPromptLink, CustomizeWithAgent } from "@/components/CustomizeWithAgent";
import { ConfirmReplaceDialog } from "@/components/controller/ConfirmReplaceDialog";
import { ConfirmReuploadDialog } from "@/components/controller/ConfirmReuploadDialog";
import { ConfirmEndDialog } from "@/components/controller/ConfirmEndDialog";
import { idbPut, idbGet, idbList, idbDelete } from "@/lib/localStore";
import { newLocalDeckId } from "@/lib/localId";
import { isDeckWatchSupported, PDF_PICKER_OPTIONS } from "@/lib/deckWatcher";
import { getSessionAuth, setSessionAuth, endSession } from "@/lib/utils";
import { lsRemove, lsSetString, sessionKey, deckWatchKey } from "@/lib/storage";
import { forgetDeckRetained } from "@/lib/plugins/host";
import { useSetting } from "@/lib/settings";
import { track, sha256Hex } from "@/lib/analytics";
import { matchReupload } from "@/lib/reupload";
import { TYPST_PACKAGE_VERSION } from "@/lib/packageVersions";
import { loadExternalPdfMeta, createExternalSession } from "@/lib/externalSession";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import "@/lib/pdf"; // ensure pdf.js worker is configured

const REPO_URL = "https://github.com/benedict-armstrong/presio";
const TYPST_PACKAGE_URL = "https://github.com/benedict-armstrong/presio-typst-package";
const LATEX_PACKAGE_URL = "https://github.com/benedict-armstrong/presio-latex-package";
const OVERLEAF_EXAMPLE_URL =
  "https://www.overleaf.com/docs?snip_uri[]=https://raw.githubusercontent.com/benedict-armstrong/presio-latex-package/main/starter/main.tex&snip_uri[]=https://raw.githubusercontent.com/benedict-armstrong/presio-latex-package/main/presio.sty&snip_uri[]=https://raw.githubusercontent.com/benedict-armstrong/presio-latex-package/main/starter/clip.gif&snip_uri[]=https://raw.githubusercontent.com/benedict-armstrong/presio-latex-package/main/starter/poster.png&snip_name[]=main.tex&snip_name[]=presio.sty&snip_name[]=clip.gif&snip_name[]=poster.png&engine=pdflatex";

const FEATURES = [
  {
    title: "Local by default",
    body: "Decks are decoded and stored in this browser. Nothing is uploaded unless you choose to share.",
  },
  {
    title: "No account, no install",
    body: "Drop a PDF and present. Signing in to sync decks across devices and with viewers.",
  },
  {
    title: "Speaker notes",
    body: "Written straight into your Typst or LaTeX source and read back out of the PDF.",
  },
  {
    title: "Embedded media",
    body: "GIFs, MP4s and YouTube or Vimeo links play in place, inside the slide.",
  },
  {
    title: "Drawing and laser pointer",
    body: "Annotate slides from the controller",
  },
  {
    title: "Presenter view",
    body: "Current slide, next slide, notes and a running timer, on your screen only.",
  },
  {
    title: "Share by code",
    body: "One short code joins any screen. A second window, a projector, or a phone. Unlimited number of viewers.",
  },
  {
    title: "Hot reload",
    body: "Recompile the deck and Presio picks the new file up without losing your place.",
  },
  {
    title: "Works offline",
    body: "Install it as an app and present with no connection at all.",
  },
];

const TYPST_EXAMPLE_PDF_URL =
  "https://raw.githubusercontent.com/benedict-armstrong/presio-typst-package/main/examples/plain/example.pdf";
const LATEX_EXAMPLE_PDF_URL =
  "https://raw.githubusercontent.com/benedict-armstrong/presio-latex-package/main/starter/main.pdf";


// Official Typst logo (Simple Icons, CC0).
function TypstMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="#239DAD"
      className="h-5 w-5 shrink-0"
      role="img"
      aria-label="Typst"
    >
      <path d="M12.654 17.846c0 1.114.16 1.861.479 2.242.32.381.901.572 1.743.572.872 0 1.99-.44 3.356-1.319l.871 1.45C16.547 22.931 14.44 24 12.785 24c-1.656 0-2.964-.395-3.922-1.187-.959-.82-1.438-2.256-1.438-4.307V6.989H5.246l-.349-1.626 2.528-.791V2.418L12.654 0v4.835l5.142-.395-.48 2.857-4.662-.176v10.725Z" />
    </svg>
  );
}

// Official LaTeX wordmark (Wikimedia Commons, public domain).
function LatexMark() {
  return (
    <svg
      viewBox="0 0 1200 500"
      fill="#103bc9"
      className="h-4 w-auto shrink-0"
      role="img"
      aria-label="LaTeX"
    >
      <path d="m5.46 4.23h-.25c-.1 1.02-.24 2.26-2 2.26h-.81c-.47 0-.49-.07-.49-.4v-5.31c0-.34 0-.48.94-.48h.33v-.3c-.36.03-1.26.03-1.67.03-.39 0-1.17 0-1.51-.03v.3h.23c.77 0 .79.11.79.47v5.25c0 .36-.02.47-.79.47h-.23v.31h5.19z" transform="matrix(45 0 0 45 40 47.65)" />
      <path d="m2.81.16c-.04-.12-.06-.16-.19-.16s-.16.04-.2.16l-1.61 4.08c-.07.17-.19.48-.81.48v.25h1.55v-.25c-.31 0-.5-.14-.5-.34 0-.05.01-.07.03-.14 0 0 .34-.86.34-.86h1.98l.4 1.02c.02.04.04.09.04.12 0 .2-.38.2-.57.2v.25h1.97v-.25h-.14c-.47 0-.52-.07-.59-.27 0 0-1.7-4.29-1.7-4.29zm-.4.71.89 2.26h-1.78z" transform="matrix(45 0 0 45 151.6 40)" />
      <path d="m6.27 0h-6.09s-.18 2.24-.18 2.24h.24c.14-1.61.29-1.94 1.8-1.94.18 0 .44 0 .54.02.21.04.21.15.21.38v5.25c0 .34 0 .48-1.05.48h-.4v.31c.41-.03 1.42-.03 1.88-.03s1.49 0 1.9.03v-.31h-.4c-1.05 0-1.05-.14-1.05-.48v-5.25c0-.2 0-.34.18-.38.11-.02.38-.02.57-.02 1.5 0 1.65.33 1.79 1.94h.25s-.19-2.24-.19-2.24z" transform="matrix(45 0 0 45 356.35 50.35)" />
      <path d="m6.16 4.2h-.25c-.25 1.53-.48 2.26-2.19 2.26h-1.32c-.47 0-.49-.07-.49-.4v-2.66h.89c.97 0 1.08.32 1.08 1.17h.25v-2.64h-.25c0 .85-.11 1.16-1.08 1.16h-.89v-2.39c0-.33.02-.4.49-.4h1.28c1.53 0 1.79.55 1.95 1.94h.25l-.28-2.24h-5.6v.3h.23c.77 0 .79.11.79.47v5.22c0 .36-.02.47-.79.47h-.23v.31h5.74z" transform="matrix(45 0 0 45 602.5 150.25)" />
      <path d="m3.76 2.95 1.37-2c.21-.32.55-.64 1.44-.65v-.3h-2.38v.3c.4.01.62.23.62.46 0 .1-.02.12-.09.23 0 0-1.14 1.68-1.14 1.68l-1.28-1.92c-.02-.03-.07-.11-.07-.15 0-.12.22-.29.64-.3v-.3c-.34.03-1.07.03-1.45.03-.31 0-.93-.01-1.3-.03v.3h.19c.55 0 .74.07.93.35 0 0 1.83 2.77 1.83 2.77l-1.63 2.41c-.14.2-.44.66-1.44.66v.31h2.38v-.31c-.46-.01-.63-.28-.63-.46 0-.09.03-.13.1-.24l1.41-2.09 1.58 2.38c.02.04.05.08.05.11 0 .12-.22.29-.65.3v.31c.35-.03 1.08-.03 1.45-.03.42 0 .88.01 1.3.03v-.31h-.19c-.52 0-.73-.05-.94-.36 0 0-2.1-3.18-2.1-3.18z" transform="matrix(45 0 0 45 845.95 47.65)" />
    </svg>
  );
}

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

// ThemeProvider toggles `dark` on <html>, so the demo follows it by watching
// that class rather than prefers-color-scheme — the in-app toggle has to win.
function useIsDark() {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark")
  );
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setDark(root.classList.contains("dark"));
    read();
    const obs = new MutationObserver(read);
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// Tailwind's md breakpoint, read from JS: the parallax has to know whether the
// two windows are overlapping or stacked, and only CSS knows that otherwise.
// Keep in step with the md: classes on the inset in DemoReel.
const OVERLAP_QUERY = "(min-width: 768px)";

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const read = () => setMatches(mq.matches);
    read();
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, [query]);
  return matches;
}

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
function DemoReel() {
  const controllerRef = useRef<HTMLVideoElement | null>(null);
  const viewerRef = useRef<HTMLVideoElement | null>(null);
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Each theme has its own pair of recordings. Swapping src reloads the video
  // from zero, so the position is carried across the switch.
  const dark = useIsDark();
  const theme = dark ? "dark" : "light";
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
          className="block w-full"
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
            className="block w-full"
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

// Shared scroll-reveal: dims + drops an element until it enters the
// viewport, then brightens it as the page scrolls further (used for every
// section below the hero demo reel).
function useScrollReveal() {
  const ref = useRef<HTMLDivElement | null>(null);
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [inView, setInView] = useState(() => reducedMotion);
  const [scrollY, setScrollY] = useState(() =>
    reducedMotion ? 0 : typeof window !== "undefined" ? window.scrollY : 0
  );

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView]);

  useEffect(() => {
    const onScroll = () => setScrollY(window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const RAMP_PX = 500;
  const progress = inView ? (reducedMotion ? 1 : Math.min(1, scrollY / RAMP_PX)) : 0;
  const opacity = 0.4 + progress * 0.6;

  return { ref, inView, opacity };
}

function ScrollReveal({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const { ref, inView, opacity } = useScrollReveal();
  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ease-out ${inView ? "translate-y-0" : "translate-y-7"} ${className}`}
      style={{ opacity }}
    >
      {children}
    </div>
  );
}
function formatRecentDate(ts: number): string {
  const d = new Date(ts);
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

// One row in the recents list: everything this browser could control. Local
// decks come from IndexedDB; synced ones are discovered through the controller
// credentials this browser holds (created+synced here, or taken over via
// passphrase) — the IndexedDB record is deleted on claim, so without the
// credential scan a shared deck would vanish from the list. Account decks come
// from the signed-in user's server-side list, so they show up on any device
// they sign in on, with the controller token the server legitimately holds.
interface RecentDeck {
  id: string;
  filename: string;
  totalSlides: number;
  /** Present only for local decks (IndexedDB creation time). */
  createdAt: number | null;
  /** Local decks only: SHA-256 of the stored PDF's bytes, when known — lets a
   * re-drop be recognised as byte-identical without touching the blob. */
  sha256?: string;
  kind: "local" | "synced" | "account";
  /** Account decks only: the controller token returned by /api/sessions/mine. */
  controllerToken?: string;
}

const SESSION_KEY_RE = /^session_([A-Z0-9]{6})$/;

// A dropped file that matched a known presentation and is waiting on the
// update-vs-create prompt. The decoded blob is kept so "Create separate"
// doesn't re-read or re-parse the file. (The ArrayBuffer it came from is not:
// getDocument() has already transferred it to the pdf.js worker by this point,
// leaving it detached.)
interface ReuploadPrompt {
  target: RecentDeck;
  file: File;
  blob: Blob;
  sha256?: string;
  filename: string;
  totalSlides: number;
  /** Whether the file's bytes were actually compared (local decks only). */
  compared: boolean;
  /** File System Access handle for the drop, when the browser provided one —
   * persisted with the update so the deck stays watchable afterwards. */
  handle?: FileSystemFileHandle;
}

async function listControlledSynced(): Promise<RecentDeck[]> {
  // Every probe below has to time out before the next one starts, so offline
  // this scan turns a page that has all its local decks in hand into a page
  // that sits there. The decks it finds are server-hosted and unreachable
  // anyway, so skip it rather than wait it out.
  if (!navigator.onLine) return [];
  const ids: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const m = key.match(SESSION_KEY_RE);
      if (m && localStorage.getItem(key)?.includes("controllerToken")) ids.push(m[1]);
    }
  } catch {
    return []; // storage unavailable (private mode): nothing to scan
  }
  const out: RecentDeck[] = [];
  // A browser only controls a handful of decks; a small sequential scan keeps
  // this trivial and ordered by insertion (most recent credential first).
  for (const id of ids.slice(0, 20)) {
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) {
        // Ended or expired server-side: the stored credential is dead weight.
        lsRemove(`session_${id}`);
        continue;
      }
      const s = await res.json();
      if (s.local) continue; // local rows are listed from IndexedDB above
      out.push({
        id,
        filename: s.filename,
        totalSlides: s.total_slides,
        createdAt: null,
        kind: "synced",
      });
    } catch {
      // Offline or server unreachable: skip rather than block the page.
    }
  }
  return out;
}

// Decks the signed-in account owns server-side. Anonymous visitors must make
// zero extra network round-trips, so the fetch is skipped entirely when no
// session token exists — signing out drops the list back to local-only for free.
async function listAccountSynced(): Promise<RecentDeck[]> {
  // Same reasoning as above, plus getSession() itself auto-refreshes a
  // near-expiry token — a network round trip before the fetch even starts.
  if (!navigator.onLine) return [];
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return [];
  try {
    const res = await fetch("/api/sessions/mine", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as {
      id: string;
      filename: string;
      total_slides: number;
      controllerToken: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      totalSlides: row.total_slides,
      createdAt: null,
      kind: "account",
      controllerToken: row.controllerToken,
    }));
  } catch {
    return []; // offline or server unreachable: skip rather than block the page
  }
}


export default function Home() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const CODE_LENGTH = 6;
  const [chars, setChars] = useState<string[]>(Array(CODE_LENGTH).fill(""));
  const charRefs = useRef<(HTMLInputElement | null)[]>([]);
  const code = chars.join("");
  const [pdfUrl, setPdfUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  // "I know how Presio works": drops the headline, the demo reel and the
  // marketing sections, leaving the drop zone centred on an empty page. Read
  // synchronously from storage so a returning user never sees the full page
  // flash past on the way to the stripped one.
  const [minimal, toggleMinimal] = useSetting("home.minimal");
  const [scrolled, setScrolled] = useState(false);
  const [exampleBusy, setExampleBusy] = useState<"typst" | "latex" | null>(null);
  const [exampleError, setExampleError] = useState("");

  // Presentations this browser could control, with an in-place "Replace PDF"
  // action so a recompiled deck keeps its code instead of minting a new one.
  const [recents, setRecents] = useState<RecentDeck[]>([]);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<RecentDeck | null>(null);
  const [replaceFile, setReplaceFile] = useState<File | null>(null);
  const [replaceHandle, setReplaceHandle] = useState<FileSystemFileHandle | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [reuploadPrompt, setReuploadPrompt] = useState<ReuploadPrompt | null>(null);
  const [closeTarget, setCloseTarget] = useState<RecentDeck | null>(null);
  const [closing, setClosing] = useState(false);
  // Whether a deck created from here should watch its file for recompiles.
  // Only meaningful where the browser can hold a file handle at all.
  const watchSupported = isDeckWatchSupported();
  const [hotReload, setHotReload] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const locals = await idbList()
        .then((rs) =>
          rs.map<RecentDeck>((r) => ({
            id: r.id,
            filename: r.filename,
            totalSlides: r.totalSlides,
            createdAt: r.createdAt,
            sha256: r.sha256,
            kind: "local",
          }))
        )
        .catch(() => [] as RecentDeck[]);
      // Independent lookups: the credential scan hits /api/sessions/:id per
      // stored token, the account list is a single call. Running them together
      // keeps the slower one off the critical path.
      const [controlled, account] = await Promise.all([
        listControlledSynced(),
        listAccountSynced(),
      ]);
      if (cancelled) return;
      // Locals first (they carry a creation date), then synced decks this
      // browser holds credentials for, then the account's remaining synced
      // decks (visible from any device); dedupe by id, preferring the earlier
      // kind — local > locally-controlled synced > account-only.
      const byId = new Map<string, RecentDeck>();
      for (const deck of [...locals, ...controlled, ...account]) {
        if (!byId.has(deck.id)) byId.set(deck.id, deck);
      }
      setRecents([...byId.values()]);
    })();
    return () => {
      cancelled = true;
    };
    // Re-listing on the user id means signing in pulls the account's decks in
    // and signing out drops back to local-only.
  }, [uploading, user?.id]);

  const pickReplace = useCallback((target: RecentDeck) => {
    setReplaceFile(null);
    setReplaceHandle(null);
    setReplaceTarget(target);
    // Chromium picks via showOpenFilePicker so the replacement keeps a
    // watchable file handle (the plain input can't provide one); other
    // browsers fall back to the input.
    if (isDeckWatchSupported()) {
      window.showOpenFilePicker?.(PDF_PICKER_OPTIONS)
        .then(async ([handle]) => {
          const file = await handle.getFile();
          if (file.type !== "application/pdf") {
            setReplaceTarget(null);
            setError("Please choose a PDF file");
            return;
          }
          setReplaceHandle(handle);
          setReplaceFile(file);
        })
        .catch(() => setReplaceTarget(null)); // cancelled: nothing to confirm
      return;
    }
    replaceInputRef.current?.click();
  }, []);

  // The whole recents row opens its controller. An account-only deck has never
  // been opened on this device, so persist the controller token the server
  // returned first — the socket join and the replace endpoint authorize with it.
  const openRecent = useCallback(
    (r: RecentDeck) => {
      if (r.kind === "account" && r.controllerToken) {
        // Spread what's already stored: setSessionAuth writes the whole record,
        // so assigning a bare { controllerToken } would drop a passphrase.
        setSessionAuth(r.id, { ...getSessionAuth(r.id), controllerToken: r.controllerToken });
      }
      track("open-recent", { kind: r.kind });
      navigate(`/s/${r.id}?role=controller`);
    },
    [navigate]
  );

  // Close (end) a presentation. A local deck's PDF only ever lived in this
  // browser, so ending it means deleting that IndexedDB copy — the same
  // teardown the controller runs in Presentation.tsx. A synced deck is ended
  // for everyone on the server: viewers are disconnected, the stored PDF is
  // dropped and the row is marked expired. Neither is recoverable, hence the
  // confirm dialog.
  const confirmClose = useCallback(async () => {
    if (!closeTarget || closing) return;
    setClosing(true);
    setError("");
    try {
      if (closeTarget.kind === "local") {
        await idbDelete(closeTarget.id);
        // A local session is presented from two windows in the same browser;
        // the viewer has no server to hear from, so tell it directly on the
        // channel Presentation listens on. Same message endPresentation sends.
        try {
          const channel = new BroadcastChannel(`presio-${closeTarget.id}`);
          channel.postMessage({ type: "session_ended" });
          channel.close();
        } catch {
          // No BroadcastChannel (or it's blocked): the deck is gone either way.
        }
      } else {
        const res = await endSession(closeTarget.id, closeTarget.controllerToken);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to close the presentation");
        }
      }
      // The stored controller credential is dead weight either way.
      lsRemove(sessionKey(closeTarget.id));
      setRecents((rs) => rs.filter((r) => r.id !== closeTarget.id));
      setCloseTarget(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to close the presentation");
      // Dismiss the dialog too: the error renders on the page behind it, so
      // leaving it up looks like the button simply did nothing.
      setCloseTarget(null);
    } finally {
      setClosing(false);
    }
  }, [closeTarget, closing]);

  // Swap a deck's PDF in place under the same code — the body shared by the
  // recents list' Replace button and the re-upload prompt's Update action.
  const replaceDeck = useCallback(
    async (target: RecentDeck, file: File, handle?: FileSystemFileHandle) => {
      const buf = await file.arrayBuffer();
      // Snapshot the bytes before getDocument() transfers the buffer to the
      // pdf.js worker and detaches it (same ordering as upload()).
      const blob = new Blob([buf], { type: "application/pdf" });
      // Fingerprint the bytes while they're still readable (see upload()).
      let sha256: string | undefined;
      try {
        sha256 = await sha256Hex(buf);
      } catch {
        // No crypto.subtle (plain-http origins): track without a fingerprint.
      }
      const doc = await openPdf({ data: new Uint8Array(buf) });
      const totalSlides = doc.numPages;
      destroyPdf(doc);
      const filename = file.name.replace(/\.pdf$/i, "");
      if (target.kind === "local") {
        try {
          // Read the record to carry over what the fresh object doesn't know:
          // the original creation time, and the watchable file handle (kept
          // when the replacement arrived without one, replaced when a new
          // handle was captured — a recompile usually lands on the same path).
          const rec = await idbGet(target.id).catch(() => null);
          await idbPut({
            id: target.id,
            filename,
            totalSlides,
            blob,
            sha256,
            createdAt: rec?.createdAt ?? target.createdAt ?? Date.now(),
            handle: handle ?? rec?.handle,
          });
        } catch {
          throw new Error(
            "Couldn't update the presentation in this browser. Private/incognito mode isn't supported — please use a normal window."
          );
        }
      } else {
        // Synced deck: overwrite its server copy. The controller token this
        // browser holds authorizes the write — for an account deck this device
        // never controlled, fall back to the token /api/sessions/mine returned.
        // A logged-in owner token is attached too when present (the server
        // accepts either).
        const stored = getSessionAuth(target.id);
        const controllerToken = stored.controllerToken ?? target.controllerToken;
        if (!controllerToken) {
          throw new Error("This browser isn't the controller for this presentation");
        }
        if (!stored.controllerToken) {
          setSessionAuth(target.id, { ...stored, controllerToken });
        }
        const headers: Record<string, string> = { "x-controller-token": controllerToken };
        const { data: sessionData } = await supabase.auth.getSession();
        if (sessionData.session) {
          headers.Authorization = `Bearer ${sessionData.session.access_token}`;
        }
        const form = new FormData();
        form.append("pdf", blob, `${filename}.pdf`);
        form.append("filename", filename);
        const res = await fetch(`/api/sessions/${target.id}/pdf`, {
          method: "POST",
          headers,
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to replace the PDF");
        }
      }
      // What plugins kept for the old deck (drawings, keyed by slide number)
      // doesn't belong on the new one.
      forgetDeckRetained(target.id);
      // Keep the in-memory recents row in step with the stored record — the
      // hash must reflect the new bytes for the next re-drop to be matched.
      setRecents((rs) =>
        rs.map((r) => (r.id === target.id ? { ...r, filename, totalSlides, sha256 } : r))
      );
      track("deck-replace", {
        filename,
        sha256,
        size: file.size,
        slides: totalSlides,
        mode: target.kind === "local" ? "local" : "server",
      });
      // A synced replace rewrites the stored object at the same URL, so tell
      // the controller page to fetch past any copy this browser already has —
      // it's the one most likely to be holding the pre-replace deck. Viewers
      // in the room get there by their own route (the deck_updated broadcast).
      navigate(`/s/${target.id}?role=controller`, { state: { deckReplaced: Date.now() } });
    },
    [navigate]
  );

  const confirmReplace = useCallback(async () => {
    if (!replaceTarget || !replaceFile || replacing) return;
    setReplacing(true);
    setError("");
    try {
      await replaceDeck(replaceTarget, replaceFile, replaceHandle ?? undefined);
      setReplaceTarget(null);
      setReplaceFile(null);
      setReplaceHandle(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to replace the PDF");
    } finally {
      setReplacing(false);
    }
  }, [replaceTarget, replaceFile, replaceHandle, replacing, replaceDeck]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The plain create path: store the deck locally under an id minted here, and
  // open share. Nothing on this path touches the network — the deck's bytes,
  // its id and everything keyed by it are local to this browser, so a PDF can
  // be imported and presented with no connection at all. The join code (and the
  // `sessions` row behind it) is created later, server-side, if and when the
  // presenter shares the deck.
  const createDeck = useCallback(
    async (p: {
      file: File;
      blob: Blob;
      sha256?: string;
      filename: string;
      totalSlides: number;
      handle?: FileSystemFileHandle;
    }) => {
      const id = newLocalDeckId();
      try {
        await idbPut({
          id,
          filename: p.filename,
          totalSlides: p.totalSlides,
          blob: p.blob,
          sha256: p.sha256,
          ...(p.handle ? { handle: p.handle } : {}),
          createdAt: Date.now(),
        });
      } catch {
        throw new Error(
          "Couldn't store the presentation in this browser. Private/incognito mode isn't supported — please use a normal window."
        );
      }
      // Remember how this deck should treat recompiles. The handle is stored
      // either way, so the controller's live-reload control can turn watching
      // on later without asking for the file again.
      lsSetString(deckWatchKey(id), p.handle && hotReload ? "prompt" : "off");
      // Counted only once the deck is durably stored; the analytics sink
      // timestamps each event, so two uploads of the same filename can be
      // compared by hash to spot recompiled vs. re-uploaded decks.
      track("upload", { filename: p.filename, sha256: p.sha256, size: p.file.size, slides: p.totalSlides });
      navigate(`/s/${id}/share`);
    },
    [navigate, hotReload]
  );

  const upload = useCallback(
    async (file: File, handle?: FileSystemFileHandle) => {
      setError("");
      setUploading(true);
      setProgress(0);
      try {
        const buf = await file.arrayBuffer();
        // Store an in-memory copy rather than the File itself. A File from the
        // picker is only a reference to the file on disk, and IndexedDB
        // persists that reference — not the bytes. If the file is moved,
        // edited, or removed before the deck is synced (the login round-trip
        // alone is enough on some browsers), reading it back fails partway
        // through the upload and the server sees a truncated multipart body.
        // Snapshot before getDocument(), which transfers the buffer to the
        // pdf.js worker and leaves it detached.
        const blob = new Blob([buf], { type: "application/pdf" });
        // Fingerprint the bytes while they're still readable — getDocument()
        // below transfers the buffer to the pdf.js worker and detaches it.
        // Hashing reads memory already in hand, so it adds no file I/O, and
        // only the digest ever leaves the browser.
        let sha256: string | undefined;
        try {
          sha256 = await sha256Hex(buf);
        } catch {
          // No crypto.subtle (e.g. plain-http origins): report the upload
          // without a fingerprint rather than blocking it.
        }
        setProgress(100);
        const doc = await openPdf({ data: new Uint8Array(buf) });
        const totalSlides = doc.numPages;
        destroyPdf(doc);
        const filename = file.name.replace(/\.pdf$/i, "");

        // Fork on a re-upload before anything is created: the recents list is
        // already in memory, so the comparison costs no network round-trip and
        // a no-match drop adds no prompt or delay.
        const match = await matchReupload(filename, sha256, recents);
        if (match?.identical) {
          // Byte-identical re-drop — the person most likely lost their link
          // rather than changed their deck. Reopen the existing presentation
          // and create nothing.
          navigate(`/s/${match.target.id}?role=controller`);
          return;
        }
        if (match) {
          // Same name, different (or unverifiable) bytes: offer update vs.
          // create, defaulting to update, before anything exists server-side
          // or in IndexedDB.
          setReuploadPrompt({
            target: match.target,
            file,
            blob,
            sha256,
            filename,
            totalSlides,
            compared: match.compared,
            handle,
          });
          return;
        }
        await createDeck({ file, blob, sha256, filename, totalSlides, handle });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Upload failed";
        track("upload-error", { error: message });
        setError(message);
      } finally {
        setUploading(false);
      }
    },
    [navigate, recents, createDeck]
  );

  // Update branch of the re-upload prompt: swap the dropped file into the
  // matched presentation via the same code path as the recents Replace button.
  const confirmReuploadUpdate = useCallback(async () => {
    if (!reuploadPrompt || replacing) return;
    setReplacing(true);
    setError("");
    try {
      await replaceDeck(reuploadPrompt.target, reuploadPrompt.file, reuploadPrompt.handle);
      setReuploadPrompt(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to replace the PDF");
    } finally {
      setReplacing(false);
    }
  }, [reuploadPrompt, replacing, replaceDeck]);

  // Create branch of the re-upload prompt: continue down the plain create
  // path, reusing the already-decoded bytes.
  const confirmReuploadCreate = useCallback(async () => {
    if (!reuploadPrompt || uploading) return;
    setUploading(true);
    setError("");
    try {
      await createDeck(reuploadPrompt);
      setReuploadPrompt(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [reuploadPrompt, uploading, createDeck]);

  const submitUrl = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!pdfUrl.trim() || urlBusy) return;
      setError("");
      setUrlBusy(true);
      try {
        const meta = await loadExternalPdfMeta(pdfUrl);
        const { data: sessionData } = await supabase.auth.getSession();
        const id = await createExternalSession(meta, sessionData.session?.access_token);
        track("open-url", { ok: true });
        navigate(`/s/${id}/share`);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Failed to create session";
        track("open-url", { ok: false, error: message });
        setError(message);
      } finally {
        setUrlBusy(false);
      }
    },
    [pdfUrl, urlBusy, navigate]
  );

  const openExample = useCallback(
    async (kind: "typst" | "latex") => {
      if (exampleBusy) return;
      setExampleError("");
      setExampleBusy(kind);
      try {
        track("open-example", { kind });
        const url = kind === "typst" ? TYPST_EXAMPLE_PDF_URL : LATEX_EXAMPLE_PDF_URL;
        const meta = await loadExternalPdfMeta(url);
        const { data: sessionData } = await supabase.auth.getSession();
        const id = await createExternalSession(meta, sessionData.session?.access_token);
        navigate(`/s/${id}/share`);
      } catch (e: unknown) {
        setExampleError(e instanceof Error ? e.message : "Failed to open example");
      } finally {
        setExampleBusy(null);
      }
    },
    [exampleBusy, navigate]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file?.type !== "application/pdf") {
        setError("Please drop a PDF file");
        return;
      }
      // Capture a File System Access handle synchronously, before the event
      // object goes away, so the deck can be watched later. Falls back to the
      // plain File — no handle, no watching, everything else unchanged. Only
      // trusted for a single-file drop: with several items, items[0] might
      // not be the file the bytes came from.
      const items = e.dataTransfer.items;
      const item = items.length === 1 ? items[0] : undefined;
      const getHandle = item?.getAsFileSystemHandle?.bind(item);
      if (getHandle) {
        getHandle()
          .then((h) =>
            upload(file, h?.kind === "file" ? (h as FileSystemFileHandle) : undefined)
          )
          .catch(() => upload(file));
      } else {
        upload(file);
      }
    },
    [upload]
  );

  // Click-to-browse. Chromium opens the File System Access picker so the
  // picked deck carries a watchable handle; other browsers use the plain
  // file input and behave exactly as before.
  const openFilePicker = useCallback(() => {
    if (isDeckWatchSupported()) {
      window.showOpenFilePicker?.(PDF_PICKER_OPTIONS)
        .then(async ([handle]) => {
          const file = await handle.getFile();
          // The picker's filter is a hint, not a guarantee — check the same way
          // the drop path does rather than failing deep inside pdf.js.
          if (file.type !== "application/pdf") {
            setError("Please choose a PDF file");
            return;
          }
          upload(file, handle);
        })
        .catch(() => { /* cancelled */ });
      return;
    }
    document.getElementById("home2-file-input")?.click();
  }, [upload]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDragging(true);
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDragging(false);
  }, []);

  const onFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) upload(file);
    },
    [upload]
  );

  useEffect(() => {
    if (code.length !== CODE_LENGTH) return;
    track("join-code");
    navigate(`/s/${code}?role=viewer`);
  }, [code, navigate]);

  return (
    <div
      className="home2 min-h-screen bg-background text-foreground"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* env(safe-area-inset-top) is 0 in browser tabs; in the installed app
          it drops the nav below the status bar. */}
      <nav
        className={`sticky top-0 z-40 flex items-center justify-between gap-4 px-4 pt-[calc(env(safe-area-inset-top)+1rem)] pb-4 backdrop-blur transition-colors sm:px-6 ${scrolled ? "border-b bg-background/90" : "border-b border-transparent bg-background/70"
          }`}
      >
        <div className="flex shrink-0 items-center gap-2">
          <PresioLogo className="h-5 w-auto text-foreground" />
          <span className="font-mono text-base font-semibold tracking-tight">Presio</span>
        </div>
        <div className="flex min-w-0 items-center gap-3 sm:gap-5">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="Presio on GitHub"
            aria-label="Presio on GitHub"
            className="hidden text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
          >
            <GitHubIcon />
          </a>
          <AccountControl />
          <ThemeToggle />
        </div>
      </nav>

      {/* ---------------------------------------------------------------- hero */}
      <section
        className={
          minimal
            // Nothing follows the panel, so it centres in what's left of the
            // viewport under the nav instead of sitting under a tall hero.
            ? "relative flex min-h-[calc(100svh-9rem)] items-center px-6 py-10"
            : "relative px-6 pb-24 pt-16"
        }
      >
        <div
          className={
            minimal
              ? "mx-auto w-full max-w-[530px]"
              : "mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 md:grid-cols-[0.92fr_1.08fr] md:gap-20 xl:grid-cols-[1fr_1.05fr]"
          }
        >
          <div>
            {!minimal && (
            <div className='max-w-xl'>
              <h1 className="mb-8 font-mono text-4xl font-semibold leading-[1.06] tracking-tight md:text-5xl">
                Better PDF presentations.
                {/* Turn a PDF into a{" "}
              <span className="text-[var(--home2-accent)]">live</span> presentation. */}
              </h1>
              {/* <p className="mb-8 max-w-[46ch] text-base text-muted-foreground md:text-[17px]">
              Drop a deck and get a controller with notes and a viewer that mirrors it in real
              time — on this laptop, or on every screen in the room.
            </p> */}
            </div>
            )}

            {/* The drop target grows with the viewport but stays in a readable
                band: min() so the floor can never exceed the column it sits in
                (below md that column is narrower than the floor itself). In
                minimal mode it is the whole page, so it stays centred. */}
            <div
              className={`mx-auto w-full min-w-[min(100%,320px)] max-w-[420px] py-6 lg:max-w-[480px] xl:max-w-[530px] ${minimal ? "" : "md:mx-0"}`}
            >
              {/* Live reload needs the File System Access API, which only
                  Chromium ships. Worth telling everyone else it exists —
                  it's the difference between one drop and thirty. Minimal mode
                  is for people who already know, so it goes with the rest. */}
              {!watchSupported && !minimal && (
                <p className="mb-3 text-sm text-muted-foreground">
                  Writing your talk? Use Chrome to enable live hot reload when the slides
                  change on disk.
                </p>
              )}
              <div
                className={`cursor-pointer rounded-xl border-2 border-dashed px-9 py-14 text-center transition-colors ${dragging
                  ? "border-(--home2-accent) bg-(--home2-accent-soft)"
                  : "border-muted-foreground/25 hover:border-muted-foreground/50"
                  }`}
                onClick={openFilePicker}
              >
                {uploading ? (
                  <div className="mx-auto w-full max-w-xs space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {progress < 100 ? `Uploading… ${progress}%` : "Processing…"}
                    </p>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-(--home2-accent) transition-[width] duration-200"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="mx-auto mb-3 h-8 w-8 text-muted-foreground/70"
                    >
                      <path d="M12 15V4M12 4l-4 4M12 4l4 4" />
                      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                    </svg>
                    <p className="text-sm text-muted-foreground">Drop a PDF here or click to browse</p>
                    <p className="mt-1 text-xs text-muted-foreground/70">stays in this browser by default</p>
                  </>
                )}
                <input
                  id="home2-file-input"
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onChange={onFileSelect}
                />
              </div>

              {/* Outside the drop zone: a click in here must not open the
                  file picker. */}
              {watchSupported && (
                <label
                  className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground"
                  title="Live reload — watch this file and offer the new slides when you recompile. You're always asked before anything changes on screen; switch it off any time from the controller."
                >
                  <input
                    type="checkbox"
                    checked={hotReload}
                    onChange={(e) => setHotReload(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-(--home2-accent)"
                  />
                  <span>
                    <span className="font-medium text-foreground">Hot reload</span> — update
                    presentation if file changes on disk.
                  </span>
                </label>
              )}

              <form onSubmit={submitUrl} className="mt-3.5 flex gap-2">
                <input
                  type="url"
                  inputMode="url"
                  placeholder="…or paste a URL to a PDF"
                  value={pdfUrl}
                  onChange={(e) => setPdfUrl(e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--home2-accent)]"
                />
                {pdfUrl.trim() && (
                  <Button type="submit" variant="outline" disabled={urlBusy}>
                    {urlBusy ? "Loading…" : "Go"}
                  </Button>
                )}
              </form>

              {error && <p className="mt-3 text-center text-sm text-destructive">{error}</p>}

              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">or join existing</span>
                </div>
              </div>

              <div className="flex justify-center gap-2">
                {Array.from({ length: CODE_LENGTH }, (_, i) => (
                  <input
                    key={i}
                    ref={(el) => {
                      charRefs.current[i] = el;
                    }}
                    type="text"
                    inputMode="text"
                    maxLength={1}
                    value={chars[i]}
                    className="h-12 w-10 rounded-md border border-input bg-background text-center font-mono text-lg font-bold uppercase tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--home2-accent)]"
                    onChange={(e) => {
                      const val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
                      if (!val) return;
                      const next = [...chars];
                      next[i] = val[val.length - 1];
                      setChars(next);
                      if (i < CODE_LENGTH - 1) charRefs.current[i + 1]?.focus();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Backspace") {
                        e.preventDefault();
                        const next = [...chars];
                        if (chars[i]) {
                          next[i] = "";
                          setChars(next);
                        } else if (i > 0) {
                          next[i - 1] = "";
                          setChars(next);
                          charRefs.current[i - 1]?.focus();
                        }
                      } else if (e.key === "ArrowLeft" && i > 0) {
                        charRefs.current[i - 1]?.focus();
                      } else if (e.key === "ArrowRight" && i < CODE_LENGTH - 1) {
                        charRefs.current[i + 1]?.focus();
                      } else if (e.key === "Enter" && code.length === CODE_LENGTH) {
                        navigate(`/s/${code}?role=viewer`);
                      }
                    }}
                    onPaste={(e) => {
                      e.preventDefault();
                      const pasted = e.clipboardData.getData("text").toUpperCase().replace(/[^A-Z0-9]/g, "");
                      const next = [...chars];
                      for (let j = 0; j < CODE_LENGTH - i && j < pasted.length; j++) {
                        next[i + j] = pasted[j];
                      }
                      setChars(next);
                      const focusIdx = Math.min(i + pasted.length, CODE_LENGTH - 1);
                      charRefs.current[focusIdx]?.focus();
                    }}
                    onFocus={(e) => e.target.select()}
                  />
                ))}
              </div>

              {recents.length > 0 && (
                <div className="mt-8">
                  <div className="mb-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
                    Recent presentations
                  </div>
                  <ul className="space-y-1.5">
                    {recents.map((r) => (
                      // The open action is its own button rather than a
                      // clickable row: nesting Replace/Close inside a
                      // `role="button"` row is invalid ARIA, and Enter/Space on
                      // an inner button would activate both it and the row.
                      <li
                        key={r.id}
                        className="flex items-center gap-2 rounded-md border px-3 py-2 transition-colors focus-within:border-muted-foreground/50 hover:border-muted-foreground/50"
                      >
                        <button
                          type="button"
                          aria-label={`Open ${r.filename}`}
                          onClick={() => openRecent(r)}
                          className="min-w-0 flex-1 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--home2-accent)]"
                        >
                          <p className="truncate text-sm font-medium">{r.filename}</p>
                          <p className="text-xs text-muted-foreground">
                            {r.totalSlides} {r.totalSlides === 1 ? "slide" : "slides"}
                            {" · "}
                            <span
                              className={r.kind === "local" ? undefined : "text-(--home2-accent)"}
                            >
                              {r.kind === "local" ? "local" : r.kind === "synced" ? "shared" : "synced"}
                            </span>
                            {r.createdAt !== null && ` · ${formatRecentDate(r.createdAt)}`}
                          </p>
                        </button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Swap in a recompiled PDF — keeps this presentation's code"
                          disabled={replacing}
                          onClick={() => pickReplace(r)}
                        >
                          <RefreshCw size={14} />
                          Replace
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title={
                            r.kind === "local"
                              ? "Delete this presentation from this browser — cannot be undone"
                              : "End this presentation for everyone — cannot be undone"
                          }
                          disabled={closing}
                          onClick={() => setCloseTarget(r)}
                        >
                          <X size={14} />
                          Close
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* The escape hatch for returning users, and the only way back:
                  it stays visible in minimal mode so the explainer can be
                  brought back without clearing storage. The label names what
                  the click does, so it flips with the mode. */}
              {/* Minimal mode hides the "make it yours" section, so the
                  plugin prompt gets a quiet entry point of its own here. */}
              <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
                {minimal && <CopyAgentPromptLink />}
                <button
                  type="button"
                  onClick={() => toggleMinimal(!minimal)}
                  className="cursor-pointer rounded-sm text-center text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--home2-accent)]"
                >
                  {minimal ? "How does Presio work?" : "Hide distractions"}
                </button>
              </div>
            </div>
          </div>

          {/* The demo reel from the README. Shipped as H.264 rather than the
              34 MB GIF the README links to: same 27 s recording, ~2.9 MB, and
              it decodes on the GPU instead of the main thread. */}
          {!minimal && <DemoReel />}
        </div>
      </section>

      {!minimal && (
      <>
      {/* ------------------------------------------------------------ plugins */}
      <section id="customize" className="px-6 py-24 md:py-28">
        <ScrollReveal className="mx-auto max-w-6xl">
          <CustomizeWithAgent />
        </ScrollReveal>
      </section>

      {/* ---------------------------------------------------------- integrations */}
      <section id="integrations" className="px-6 py-24 md:py-28">
        <ScrollReveal className="mx-auto max-w-6xl">
          <div className="mb-12 max-w-2xl">
            <div className="mb-3.5 font-mono text-xs font-semibold uppercase tracking-wide text-(--home2-accent)">
              Typst &amp; LaTeX packages
            </div>
            <h2 className="mb-3 text-xl font-semibold leading-tight tracking-tight md:text-2xl">
              Write speaker notes and media straight into your source.
            </h2>
            <p className="max-w-[52ch] text-[15px] text-muted-foreground">
              Presio ships companion packages for both Typst and LaTeX. They attach speaker
              notes and embedded media (GIFs, MP4s, YouTube/Vimeo) to your PDF in a format Presio
              reads automatically — no manual annotation wiring needed.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-10 md:grid-cols-2 md:gap-8">
            <div className="flex flex-col rounded-2xl p-6">
              <div className="mb-5 flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 font-mono text-lg font-bold text-(--home2-accent)">
                  <TypstMark />
                  Typst
                </h2>
                <a
                  href={TYPST_PACKAGE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
                >
                  presio-typst-package <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <p className="mb-4 text-sm text-muted-foreground">
                Import it at the top of your document, then call{" "}
                <code className="rounded bg-muted px-1 text-xs">speaker-notes</code> and{" "}
                <code className="rounded bg-muted px-1 text-xs">media</code> anywhere in your
                slides. Works with plain Typst, Polylux, or Touying.
              </p>
              <CodeBlock
                code={`#import "@preview/presio:${TYPST_PACKAGE_VERSION}": media, speaker-notes

= Introduction

Hello world.

#speaker-notes[
  Remember to mention the funding agency before the next slide.
]

#media(path("figures/demo.gif"), width: 60%)`}
              />
              <div className="mt-auto flex pt-4">
                <Button variant="outline" disabled={exampleBusy !== null} onClick={() => openExample("typst")}>
                  {exampleBusy === "typst" ? "Opening…" : "Try in Presio"}
                </Button>
              </div>
            </div>

            <div className="flex flex-col rounded-2xl p-6">
              <div className="mb-5 flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 font-mono text-lg font-bold text-(--home2-accent)">
                  <LatexMark />
                  LaTeX
                </h2>
                <a
                  href={LATEX_PACKAGE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
                >
                  presio-latex-package <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <p className="mb-4 text-sm text-muted-foreground">
                Drop <code className="rounded bg-muted px-1 text-xs">presio.sty</code> next to
                your <code className="rounded bg-muted px-1 text-xs">.tex</code> file and load it
                with <code className="rounded bg-muted px-1 text-xs">\usepackage</code>. Works
                with beamer, powerdot, or plain one-slide-per-page documents.
              </p>
              <CodeBlock
                lang="latex"
                code={`\\documentclass{beamer}
\\usepackage{presio}

\\begin{document}

\\begin{frame}{Introduction}
  Hello world.
  \\presionote{Remember to mention the demo before moving on.}
\\end{frame}

\\begin{frame}{The demo}
  \\presiomedia[width=0.7\\linewidth]{https://www.youtube.com/watch?v=dQw4w9WgXcQ}
\\end{frame}

\\end{document}`}
              />
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                <Button variant="outline" asChild>
                  <a href={OVERLEAF_EXAMPLE_URL} target="_blank" rel="noopener noreferrer">
                    Open example in Overleaf
                  </a>
                </Button>
                <Button variant="outline" disabled={exampleBusy !== null} onClick={() => openExample("latex")}>
                  {exampleBusy === "latex" ? "Opening…" : "Try in Presio"}
                </Button>
              </div>
            </div>
          </div>

          {exampleError && <p className="mt-4 text-sm text-destructive">{exampleError}</p>}
        </ScrollReveal>
      </section>

      {/* ------------------------------------------------------------ features */}
      <section id="features" className="px-6 py-24 md:py-28">
        <ScrollReveal className="mx-auto max-w-6xl">
          <div className="mb-10 max-w-2xl">
            <h2 className="text-2xl font-semibold leading-tight tracking-tight md:text-3xl">
              Features:
            </h2>
          </div>

          <ul className="grid grid-cols-1 gap-x-12 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <li key={f.title}>
                <h3 className="text-[15px] font-medium">{f.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
              </li>
            ))}
          </ul>

          <p className="mt-12 text-sm text-muted-foreground">
            Missing something?{" "}
            <a
              href={`${REPO_URL}/issues/new`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 hover:text-[var(--home2-accent)]"
            >
              Open a feature request on GitHub
            </a>{" "}
          </p>
        </ScrollReveal>
      </section>

      </>
      )}

      <footer className="px-6 py-8">
        <ScrollReveal className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 text-xs text-muted-foreground sm:flex-row">
          <span>© Presio — built for presenting PDFs</span>
          <div className="flex gap-4">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="Presio on GitHub"
              aria-label="Presio on GitHub"
              className="inline-flex items-center hover:text-foreground"
            >
              <GitHubIcon className="h-3.5 w-3.5" />
            </a>
            {/* The app is served from more than one domain, so name the one
                the visitor is actually on rather than hardcoding a host that
                may be blocked on their network (#74). */}
            <Link to="/check" className="hover:text-foreground">
              {typeof window === "undefined" ? "/check" : `${window.location.host}/check`}
            </Link>
          </div>
        </ScrollReveal>
      </footer>

      {replaceTarget && replaceFile && (
        <ConfirmReplaceDialog
          onConfirm={confirmReplace}
          onClose={() => { setReplaceTarget(null); setReplaceFile(null); setReplaceHandle(null); }}
        />
      )}

      {reuploadPrompt && (
        <ConfirmReuploadDialog
          filename={reuploadPrompt.filename}
          code={reuploadPrompt.target.id}
          compared={reuploadPrompt.compared}
          onUpdate={confirmReuploadUpdate}
          onCreate={confirmReuploadCreate}
          onClose={() => setReuploadPrompt(null)}
        />
      )}

      {closeTarget && (
        <ConfirmEndDialog
          local={closeTarget.kind === "local"}
          onConfirm={confirmClose}
          onClose={() => setCloseTarget(null)}
        />
      )}

      {/* Hidden picker for the recents list' Replace action. Kept outside the
          list so a cancelled picker simply leaves nothing to confirm. */}
      <input
        ref={replaceInputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        data-testid="recents-replace-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) setReplaceFile(file);
          e.target.value = "";
        }}
      />

      <MobileNotice />
    </div>
  );
}
