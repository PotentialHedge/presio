// Single source of truth for the version of the Typst package the docs pin.
//
// Deliberately a committed constant and not a runtime lookup: the homepage has
// to render the correct snippet with no third-party API reachable, which is the
// normal case for self-hosted and offline deploys. Bumps come from
// .github/workflows/package-versions.yml, which opens a PR when this falls
// behind.
//
// This tracks what Typst Universe actually serves, not the tags on
// PotentialHedge/presio-typst-package: `@preview/presio:<version>` only
// resolves once a release has been published there, so a freshly tagged version
// would break every snippet that copies this.
//
// README.md and example/example.typ are not built from TypeScript, so they
// repeat the literal; the workflow above rewrites all three together.
export const TYPST_PACKAGE_VERSION = "0.2.3";

// The LaTeX package (PotentialHedge/presio-latex-package) is installed by
// copying presio.sty next to the .tex file and publishes no versioned releases,
// so there is no version to pin for it. The workflow flags it if that changes.
