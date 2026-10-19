// Fine-grained Shiki bundle: only the languages/themes the code samples need,
// so we don't pull in Shiki's full grammar/theme set.
import type { HighlighterCore } from "shiki/core";

let highlighterPromise: Promise<HighlighterCore> | null = null;

// Created once and shared across every CodeBlock on the page. Everything is
// imported dynamically: the LaTeX grammar embeds C++, TypeScript, PHP and
// more for its code environments, megabytes the home page would otherwise
// parse before first paint. CodeBlock shows plain code until this resolves.
export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }, typst, latex, githubLight, githubDark] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/oniguruma"),
          import("shiki/langs/typst.mjs"),
          import("shiki/langs/latex.mjs"),
          import("shiki/themes/github-light.mjs"),
          import("shiki/themes/github-dark.mjs"),
        ]);
      // Typst's grammar embeds ~60 languages for the code in its raw blocks,
      // and compiling them all was half a second of main thread. The samples
      // have no raw blocks, so register Typst alone; Shiki would otherwise
      // refuse it for the missing embeds.
      const typstOnly = typst.default
        .filter((lang) => lang.name === "typst")
        .map((lang) => ({ ...lang, embeddedLangs: [] }));
      return createHighlighterCore({
        themes: [githubLight.default, githubDark.default],
        langs: [typstOnly, latex.default],
        engine: createOnigurumaEngine(import("shiki/wasm")),
      });
    })();
  }
  return highlighterPromise;
}
