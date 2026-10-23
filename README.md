# Presio

Present PDFs from your browser: a no-install alternative to
[Pympress](https://github.com/Cimbali/pympress). Try it at
**[presio.ch](https://presio.ch)** or **[presio.xyz](https://presio.xyz)**
(use presio.ch if your institution blocks `.xyz`).

**[Plugins](https://github.com/topics/presio-plugin)**

Open a PDF, drive the slides from one browser window and show them in another.
This repository is the source of the hosted service.

![Demo](https://github.com/PotentialHedge/presio/releases/download/demo/presio.gif)

![How it works](example/diagram.png)

## Features

- **Local by default**: your PDF stays in the browser and works offline. Local presentations are kept for 7 days.
- **Controller + viewer**: the viewer window mirrors the controller, in sync.
- **Present across devices**: log in and sync to get a 6-character code. Viewers enter it on the home page and follow along live.
- **Shared control**: give someone a passphrase to drive.
- **Speaker notes**: shown next to the current and next slide, rendered as markdown.
- **Embedded media**: videos, GIFs and YouTube/Vimeo, with playback synced to viewers.
- **Timer**, a **customizable layout** and **remappable shortcuts**.
- **Plugins**: add features such as polls or captions; see [Plugins](#plugins).
- **Agent APIs**: an MCP server and a REST API; see [Use it from an AI agent](#use-it-from-an-ai-agent).

## Adding videos and speaker notes

Any PDF works. For notes and media, use the official packages, or embed them
by hand (see [Embedding notes by hand](#embedding-notes-by-hand)):

- **Typst** — [presio-typst-package](https://github.com/PotentialHedge/presio-typst-package)
- **LaTeX** — [presio-latex-package](https://github.com/PotentialHedge/presio-latex-package)

### Typst

```typst
#import "@preview/presio:0.2.3": media, speaker-notes

= Introduction

Hello world.

#speaker-notes[
  Remember to mention the demo before moving on.
]

#media("https://www.youtube.com/watch?v=dQw4w9WgXcQ", width: 60%, aspect-ratio: 16/9)
```

### LaTeX

[![Open in Overleaf](https://img.shields.io/badge/Open%20in%20Overleaf-1F2A37?logo=overleaf&logoColor=white)](https://www.overleaf.com/docs?snip_uri[]=https://raw.githubusercontent.com/PotentialHedge/presio-latex-package/main/starter/main.tex&snip_uri[]=https://raw.githubusercontent.com/PotentialHedge/presio-latex-package/main/presio.sty&snip_uri[]=https://raw.githubusercontent.com/PotentialHedge/presio-latex-package/main/starter/clip.gif&snip_uri[]=https://raw.githubusercontent.com/PotentialHedge/presio-latex-package/main/starter/poster.png&snip_name[]=main.tex&snip_name[]=presio.sty&snip_name[]=clip.gif&snip_name[]=poster.png&engine=pdflatex)

```latex
\documentclass{beamer}
\usepackage{presio}

\begin{document}

\begin{frame}{Introduction}
  Hello world.
  \presionote{Remember to mention the demo before moving on.}
\end{frame}

\begin{frame}{The demo}
  \presiomedia[width=0.7\linewidth]{https://www.youtube.com/watch?v=dQw4w9WgXcQ}
\end{frame}

\end{document}
```

To install, copy `presio.sty` from the package repository next to your `.tex` file.

### Embedding notes by hand

Presio reads speaker notes from JSON files attached to the PDF (Typst) or from
`note:` link annotations (LaTeX).

Typst: define a helper and call it on each slide:

```typst
#let speaker-notes(notes) = context {
  // Page number keeps the attachment filename unique per slide
  let page-num = counter(page).display()
  let filename = "notes-slide-" + page-num + ".json"

  let json-string = json.encode((slide: page-num, notes: notes))

  pdf.attach(
    filename,
    bytes(json-string),
    description: "Speaker notes for slide " + page-num,
    mime-type: "application/json",
  )
}

#speaker-notes("Remember to mention the demo.")
```

LaTeX: use `hyperref` to create an invisible `note:` link:

```latex
\usepackage{hyperref}

\newcommand{\speakernote}[1]{%
  \href{note:#1}{\phantom{n}}%
}

% Usage on a slide:
\speakernote{Remember to mention the demo.}
```

Check the result at [presio.ch/check](https://presio.ch/check), which reports
whether the notes and media on each page are valid.

## Plugins

Plugins add features such as live polls or closed captions. Browse them under
the [`presio-plugin`](https://github.com/topics/presio-plugin) topic on GitHub
and add one from Settings → Discover plugins.

To build your own, paste this prompt into Claude Code, Codex or Cursor:

```text
Read https://presio.ch/plugins.md and build me a Presio plugin. Ask me what it should do first.
```

## Use it from an AI agent

Agents can present and check PDFs over MCP or REST. Start at
[presio.ch/llms.txt](https://presio.ch/llms.txt). To add the MCP server to
Claude Code:

```bash
claude mcp add --transport http presio https://presio.ch/mcp
```

## Self-hosting

For a full deployment (accounts, cross-device sync, your own domain) see
[`deploy/README.md`](deploy/README.md).

For a single offline container with no accounts or Supabase:

```bash
docker run -d -p 3001:3001 -e PRESIO_MODE=local -e LOCAL_DATA_DIR=/data \
  -e TRUST_PROXY=false -v presio-data:/data \
  ghcr.io/potentialhedge/presio-local:1
```

`:1` tracks the current major version, so it gets no breaking changes (see
[Versions and upgrading](deploy/README.md#versions-and-upgrading)). See
[Running fully local / offline](deploy/README.md#running-fully-local--offline)
for what this mode includes.
