// The home page's explainer below the hero: the Typst and LaTeX packages,
// the feature list, and the footer.

import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/CodeBlock";
import { GitHubIcon } from "@/components/GitHubIcon";
import { track } from "@/lib/analytics";
import { createExternalSession, loadExternalPdfMeta } from "@/lib/externalSession";
import { TYPST_PACKAGE_VERSION } from "@/lib/packageVersions";
import { supabase } from "@/lib/supabaseClient";
import { LatexMark, TypstMark } from "./BrandMarks";
import {
  LATEX_EXAMPLE_PDF_URL,
  LATEX_PACKAGE_URL,
  OVERLEAF_EXAMPLE_URL,
  REPO_URL,
  TYPST_EXAMPLE_PDF_URL,
  TYPST_PACKAGE_URL,
} from "./links";
import { ScrollReveal } from "./ScrollReveal";

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

/** Open one of the packages' example decks, straight from GitHub. */
function useOpenExample() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"typst" | "latex" | null>(null);
  const [error, setError] = useState("");
  const open = useCallback(
    async (kind: "typst" | "latex") => {
      if (busy) return;
      setError("");
      setBusy(kind);
      try {
        track("open-example", { kind });
        const url = kind === "typst" ? TYPST_EXAMPLE_PDF_URL : LATEX_EXAMPLE_PDF_URL;
        const meta = await loadExternalPdfMeta(url);
        const { data: sessionData } = await supabase.auth.getSession();
        const id = await createExternalSession(meta, sessionData.session?.access_token);
        navigate(`/s/${id}/share`);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to open example");
      } finally {
        setBusy(null);
      }
    },
    [busy, navigate]
  );
  return { busy, error, open };
}

export function IntegrationsSection() {
  const { busy: exampleBusy, error: exampleError, open: openExample } = useOpenExample();
  return (
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
  );
}

export function FeaturesSection() {
  return (
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
  );
}

export function HomeFooter() {
  return (
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
  );
}
