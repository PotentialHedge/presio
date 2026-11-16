// presio example: touying deck (simple theme).
// Compile with: typst compile examples/touying/example.typ
#import "@preview/touying:0.7.4": *
#import themes.simple: *
#import "@preview/presio:0.3.0": media, speaker-notes

#show: simple-theme.with(aspect-ratio: "16-9")

= Welcome

A touying deck wired up with `presio`.

#speaker-notes[
  Remember to introduce yourself and thank the audience.
]

#speaker-notes[
  Second notes block on the same slide — should be concatenated.
]

== Embedded GIF

#media(path("demo.gif"), width: 60%)

#speaker-notes[
  This GIF is embedded directly in the PDF.
]

== URL-sourced media

#media(
  "https://upload.wikimedia.org/wikipedia/commons/2/2c/Rotating_earth_%28large%29.gif",
  width: 30%,
  aspect-ratio: 1,
)

#pause

Reveal Content

== YouTube

#media("https://www.youtube.com/watch?v=dQw4w9WgXcQ", width: 60%, aspect-ratio: 16 / 9)

== Vimeo

#media("https://vimeo.com/76979871", width: 60%, aspect-ratio: 16 / 9)
