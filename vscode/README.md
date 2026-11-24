# Presio Preview for VS Code

Preview a [Presio](https://presio.xyz) deck inside VS Code the way Presio shows it: the slides with their
GIFs, videos, YouTube/Vimeo embeds and HTML animations playing in place, the drawings saved in the PDF, and
your speaker notes underneath. Rebuild the PDF (Typst, LaTeX, anything) and the preview reloads on the slide
you were on.

## Use

- **Decks open here by themselves:** a PDF carrying Presio's notes or media (its `notes-slide-*.json` /
  `media-slide-*.json` attachments) opens in the preview even when another PDF viewer is the default. Other
  PDFs open as before. Reopen a deck with another editor and it stays there for the session; turn it off
  altogether with the `presio.preview.openDecks` setting.
- **From the PDF:** right-click it in the Explorer → *Open Presio Preview*, or *Open With… → Presio
  Preview*.
- **From the source:** in a `.typ` or `.tex` file, the preview button in the editor title (or *Presio: Open
  Presio Preview to the Side*) opens the PDF of the same name beside it.
- **Keys:** ←/→ (also Space, PgUp/PgDn) change slides, ⌘←/⌘→ (or Home/End) go to the first/last, and
  ⌥←/⌥→ jump between sections, the PDF outline's top-level entries (Typst `=` headings, LaTeX
  `\section`s). Plugin shortcuts work too (`k` play/pause media, `r` restart, `p` pen…).
- **Speaker notes:** click them to edit. Edits are saved into the PDF. If the PDF is built from a source
  file, the next build replaces them, so copy them into the source to keep them.
- **Open in Presio:** the button in the preview's footer (or its editor title, or *Presio: Open in
  Presio* on a PDF in the Explorer) opens the deck in Presio in your browser, on the slide you're on, ready
  to present. The PDF is uploaded to Presio (`presio.server`, presio.xyz by default) only long enough for the
  browser to take it in. Opening the same file again after a rebuild replaces the deck of the presentation
  it opened before, so its code, notes and drawings carry over.
- **Problems:** the deck's sidecars (notes, media placements) are checked as in Presio's checker, and any
  problems are listed in the Problems panel against the PDF.
- **Log:** *Output → Presio Preview* shows errors from the preview.

The preview runs Presio's built-in plugins that are about the deck itself: Media, Speaker Notes and
Drawing. Plugins installed in Presio from GitHub don't run here.

## How it works

The webview is Presio's own renderer (`client/src/embed/`), built by `npm run build:vscode` in `client/`:
pdf.js for the pages, and Presio's plugin host with the built-in plugins running in frames over the
slide. A webview's files are served from a separate origin, so everything is bundled in:

- the plugin runtime (`plugin-frame.html`) is loaded as a `srcdoc` frame (`setFrameSource`);
- each built-in plugin is a single self-contained HTML file (`standaloneBuiltinPlugins` in
  `client/plugins/build.ts`);
- the pdf.js worker is inlined and started from a blob (`setPdfWorkerFactory`).

The extension (`src/extension.ts`) is a read-only custom editor. It sends the PDF's bytes to the webview,
watches the file, writes back decks a plugin saves, and turns the webview's sidecar report into
diagnostics. The messages it exchanges with the webview are in `client/src/embed/protocol.ts`.

## Develop

```bash
cd client && npm install
cd ../vscode && npm install
npm run build          # webview (via client/) + extension → dist/
```

Then open `vscode/` in VS Code and run the extension with F5 (*Run Extension*), or
`code --extensionDevelopmentPath=$PWD path/to/deck.pdf`. To rebuild only the extension side, use
`npm run build:extension`. `npm run package` makes a `.vsix`.
