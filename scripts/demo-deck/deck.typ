// The deck recorded for the homepage hero (scripts/record-demo.mts).
//
// Deliberately not example/example.typ: that one is the media test fixture,
// and its colour-cycling test GIF reads as a rendering bug on a marketing
// page. This deck is about Presio itself — the hero shows Presio presenting
// its own feature tour — with real speaker notes, so the controller's notes
// pane and next-slide preview have something to show.
//
// The recorder choreographs against this page order, so slides cannot be
// added or reordered without re-timing scripts/record-demo.mts:
//   1 cover · 2 title · 3 laser target · 4 pen target · 5 list
//   6 media (the j6 jump lands here) · 7 payoff · 8 make it your own
//
// muybridge-horse.gif is Eadweard Muybridge's "The Horse in Motion" (1878),
// public domain, via Wikimedia Commons:
// https://commons.wikimedia.org/wiki/File:Muybridge_race_horse_animated.gif
//
// Compile with: typst compile scripts/demo-deck/deck.typ
#import "@preview/touying:0.7.4": *
#import themes.simple: *
#import "@preview/presio:0.2.3": media, speaker-notes

#show: simple-theme.with(aspect-ratio: "16-9")

// The app renders in the system UI sans (--font-sans in client/src/index.css
// is Tailwind's ui-sans-serif/system-ui stack), so the deck matches it: SF NS
// is what system-ui resolves to on the Mac this is recorded on, with the usual
// fallback for anyone compiling elsewhere.
#let app-font = ("SF NS", "Helvetica Neue")

#set text(font: app-font, size: 30pt)
#show heading: set text(font: app-font)

// The two logos the home page uses for the packages (TypstMark and LatexMark
// in client/src/pages/Home.tsx), so the deck names them the same way the site
// does. `box` keeps them inline with the surrounding words.
#let mark(file, height, baseline: 0.15em) = box(image(file, height: height), baseline: baseline)
#let typst-mark = mark("typst.svg", 1em)
// The LaTeX wordmark carries its own raised A and dropped E, so its box sits
// higher than its baseline; the drop lines it up with the words beside it.
#let latex-mark = mark("latex.svg", 1.15em, baseline: 0.3em)

// presio-logo.svg is client/public/icon.svg, kept here because Typst cannot
// read outside the deck's own directory, with the stroke darkened to match the
// slide text — in the app the mark inherits currentColor, so it is never the
// flat grey the standalone file hardcodes. It
// rides in the title itself rather than above it: the theme builds the cover
// from the heading, and anything placed before the heading becomes a ninth
// page, which the recorder's choreography has no room for.
= #mark("presio-logo.svg", 0.85em) Presio

Present PDFs from your browser.

#speaker-notes[
  Open by pointing at the screen: this deck is a PDF, and it is being driven by the thing it is describing. Keep the
  tour to five minutes.
]

== Two windows, one deck

#set text(size: 24pt)

#grid(
  columns: (1fr, 1fr),
  gutter: 2em,
  [
    - You drive the controller

    - A viewer window mirrors it

    - Or share a 6-character code
  ],
  [
    #let win(w, c) = block(width: w, radius: 3pt, stroke: 1pt + c, inset: 0pt, clip: true)[
      #block(width: 100%, height: 0.42em, fill: c)
      #block(width: 100%, height: 1.25em)
    ]
    #stack(
      spacing: 0.7em,
      win(100%, rgb("#1f2937")),
      win(100%, rgb("#6b7280")),
      win(100%, rgb("#d1d5db")),
    )
  ],
)

#speaker-notes[
  The code is the part people miss: viewers type it on the home page and follow along on their own screens. No install,
  no account.
]

== Your PDF stays on your machine

#v(0.8em)

*Local by default.*

Share online only if you want people on other devices to follow along.

#speaker-notes[
  Worth saying plainly for anyone presenting something confidential: local presentations never leave the machine!
]

== While you are talking

#v(0.6em)

+ Laser pointer and annotations supported

+ Speaker notes beside the current and next slide

+ Timer; press j+\<number> to jump anywhere

+ Embed notes and media in #typst-mark or #latex-mark

#speaker-notes[
  Demonstrate rather than read the list — the laser and the pen are already on screen by now, so just call out the timer
  and the jump.
]

== Video and GIFs, in sync

#v(0.4em)

// Captions live in their own row: the two players reserve slightly different
// heights, so a caption that follows its own player does not line up with the
// one beside it.
#grid(
  columns: (1fr, 1fr),
  column-gutter: 1.6em,
  row-gutter: 0.5em,
  // The auto placeholder draws the GIF at its natural 300pt, which is narrower
  // than the column the player will actually fill, so the still is passed in
  // scaled to match.
  media(
    path("muybridge-horse.gif"),
    width: 100%,
    aspect-ratio: 3 / 2,
    placeholder: image("muybridge-horse.gif", width: 100%),
  ),
  media(
    "https://www.youtube.com/watch?v=YE7VzlLtp-4",
    width: 100%,
    aspect-ratio: 3 / 2,
  ),
  text(size: 16pt, fill: gray)[an embedded GIF],
  text(size: 16pt, fill: gray)[a YouTube link],
)

#speaker-notes[
  Both play in place — the GIF rides along inside the PDF, the YouTube one is fetched at presentation time. Play, pause
  and seek all reach the viewers.
]

==

#v(1fr)

#align(center)[
  #text(size: 44pt, weight: "bold")[Try it on your own deck!]
]
#v(1fr)

#speaker-notes[
  Land on this slide. The packages only add notes and media; a deck with neither needs nothing beyond the PDF itself.
]

==

// The same ideas the home page's "Make it yours" section floats behind its
// button (IDEAS in client/src/components/CustomizeWithAgent.tsx), faded out
// towards the middle so the heading sits in a clear patch, the way the page's
// radial mask does it.
#let ideas = (
  ("multiple-choice polls", 26pt, false),
  ("live captions", 18pt, true),
  ("a countdown on every screen", 22pt, false),
  ("audience Q&A", 30pt, false),
  ("emoji reactions", 18pt, true),
  ("a speaker timer", 22pt, true),
  ("a QR code to join", 26pt, false),
  ("quiz with a leaderboard", 18pt, false),
  ("confetti on the last slide", 22pt, true),
  ("a laser pointer from your phone", 18pt, true),
  ("word clouds from the audience", 26pt, true),
  ("slide notes on your watch", 18pt, false),
  ("live translation", 22pt, false),
  ("a progress bar", 18pt, true),
)

#let word((idea, size, faded)) = box(text(size: size, fill: if faded { luma(185) } else { luma(135) })[#idea])

#place(center + horizon, block(width: 100%)[
  #set par(leading: 1.5em, justify: false)
  #align(center, ideas.map(word).join(h(1.1em)))
])

#place(center + horizon, rect(
  width: 120%,
  height: 120%,
  stroke: none,
  fill: gradient.radial(
    (white, 0%),
    (white, 32%),
    (white.transparentize(100%), 58%),
    (white.transparentize(100%), 100%),
  ),
))

#place(center + horizon)[
  #text(size: 48pt, weight: "bold")[Customize Presio]
]

#speaker-notes[
  Close on plugins: anything missing, a coding agent can build in minutes. Then take questions.
]
