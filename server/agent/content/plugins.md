# Writing a Presio plugin

A Presio plugin adds a feature to a live presentation — a button in the
presenter's bottom bar, a keyboard shortcut, a card on their dashboard, a layer
on every viewer's screen or on the slide itself, its own settings. It is an
HTML page plus a manifest, served from any https URL — a public GitHub repo
is enough (see [Publish on GitHub](#publish-on-github)) — or from
`http://localhost` while you build it.

Like a VS Code extension, a plugin never edits Presio's interface: it
*declares* what it adds — commands, the buttons and keys that run them,
dashboard panels, settings — and Presio draws it.

A plugin's **id** isn't declared: it comes from where the plugin is loaded
from. A repo `github:alice/presio-poll` (or the shorthand `alice/poll`) is
`alice/poll`; a repo not named `presio-…` keeps its name
(`github:alice/kit` is `alice/kit`); a plugin in a folder of a repo takes the
folder's name; one served from any other URL is `url:<host>/<name>`, with
`name` from its manifest. Built-ins are `presio/*`. Settings, keybindings,
storage, retained messages and histories are all keyed by it.

## Files

```
presio-plugin.json
index.html
```

`presio-plugin.json` ([schema](BASE/schema/plugin-manifest.schema.json)):

```json
{
  "presio": 1,
  "name": "hello",
  "displayName": "Hello",
  "version": "0.1.0",
  "author": "you",
  "description": "One line shown in Settings → Plugins.",
  "main": "index.html",
  "surfaces": ["background", "viewer"],
  "activation": ["always"],
  "permissions": [],
  "contributes": {
    "commands": [
      { "id": "toggle", "title": "Say hello", "icon": "sparkles" }
    ],
    "buttons": [
      { "command": "toggle", "location": "controller.toolbar", "label": "Hello" }
    ],
    "keybindings": [
      { "command": "toggle", "keys": [{ "key": "h" }] }
    ],
    "settings": {
      "greeting": { "type": "string", "default": "Hello!", "description": "What viewers see." }
    }
  }
}
```

- `presio` — the plugin API's major version, `1`. Required.
- `name` — a slug (`a-z`, `0-9`, `-`); `displayName` is what people see.
- `version` — semver; release it under the git tag `v` + version.
- `dependencies` — other plugins it needs, `{ "github:alice/presio-quiz-core": "^1.0.0" }`
  (validated; loading them comes later).

- `surfaces` — where the plugin runs (the same HTML in each):
  - `background`: hidden, on the presenter's device, for as long as the deck
    is open. Keep state here and handle your commands.
  - `panel`: a card on the presenter's dashboard for each entry in
    `contributes.panels` (`{ "id", "title" }`); `presio.panel` says which.
    Switching the plugin on adds them; the presenter can move, resize and
    hide them like any other card.
  - `viewer`: a full-screen layer on every viewer screen (projector and
    audience phones), hidden until the plugin calls `presio.ui.setVisible(true)`.
  - `slide`: a layer over the slide itself, sized to the page, on the
    presenter's current slide and on every viewer — for things that live on
    the page (media, drawings). It sits above the slide's links, follows the
    presenter's pinch-zoom (`presio.ui.view` says what of the page is on
    screen) and lets input through to the slide unless it asks for it with
    `presio.ui.setInteractive(true)` or a list of page areas. Two fingers stay
    Presio's even then: once a second touch lands, both pinch and pan the
    slide (the plugin still sees them, and should drop what the first began).
    `setInteractive("pen")` takes only a pen's and a mouse's input and leaves
    every finger to Presio, to pan, pinch and turn the page: a stylus draws
    while the hand moves the slide. The plugin still sees the touches (for its
    own gestures), and a hand resting while the pen is down is ignored. A
    finger that lands on the plugin's own controls (buttons, links, inputs,
    anything marked `data-control`) stays the plugin's.
    Pair it with `presio.layers` so the same content shows, still, in
    thumbnails and the next-slide preview.
- `slideSurface` — what the `slide` surface covers: `"page"` (the default),
  the page itself, or `"area"`, the whole slide area around it — the viewer's
  screen, the presenter's current slide card — letterbox bars included. For
  what belongs beside the slide rather than on it: captions that move into the
  bar below the slide when there is one, a tool palette that can sit anywhere
  on the card. `presio.ui.page` says where the page is within the surface;
  `presio.ui.view` and `setInteractive` areas are fractions of the surface
  either way.
- `activation` — `"always"`, or `"attachment:<glob>"` to run only for decks
  whose PDF embeds a matching attachment (e.g. `"attachment:poll-*.json"`).
- `permissions` — `"deck"` to read the PDF (its bytes and embedded
  attachments); `"editDeck"` to save an edited PDF over it from the presenter's
  device; `"history"` to keep an edit history for the deck (`presio.history`)
  and blobs (`presio.blobs`). `"audience"` is reserved for collecting
  viewers' input and not served yet. An unknown permission is an error.
- `contributes.commands` — what the plugin can do: `{ "id", "title", "icon"?,
  "category"? }`. Handle each with `presio.commands.register(id, handler)` in
  a frame (usually `background`); the handler gets the call's args and what it
  returns is the result. Buttons and keybindings run commands, and other
  plugins can too: `presio.commands.execute("alice/poll.open", args)`.
- `contributes.buttons` — up to 8 buttons Presio draws natively, each running
  a `command`. `location`: `controller.toolbar` (the controller's bottom
  bar), `controller.currentSlide` (the current slide card's header, as an icon
  with the label as its tooltip) or `settings` (under **Actions** on the
  plugin's page in Settings); `thumbnail.context` and `viewer.toolbar` are
  reserved. `label` and `icon` default to the command's. `icon` is one of
  `qr-code bar-chart message users timer bell star sparkles hand check eye
  megaphone pen download upload`. With `accept` (an `<input accept>` value,
  e.g. `".json,application/json"`) Presio asks the presenter for a file first
  and the command runs with `{ file }`. A plugin with presenter buttons needs a
  `background` or `panel` surface to handle them. A button can carry a small
  menu, set at runtime with `presio.ui.setButton(command, { menu })`; a pick
  runs the command with `{ menuItem }`.
- `contributes.keybindings` — default keys for commands on the presenter's
  controller: `{ "command", "keys" }`, up to 3 keys each `{ "key":
  KeyboardEvent.key, "meta"?: true }` (an empty list makes the command
  bindable with no default). They're listed under the plugin's name in
  **Settings → Keyboard shortcuts**, where the presenter can rebind them
  (stored in the `keybindings` setting as `<plugin id>.<command>`). They never
  fire while the presenter types in a field, and Presio's own shortcuts win
  where keys overlap (arrows, Space, PgUp/PgDn, `b`, `c`, `j` then digits) —
  Settings marks such a key as taken. The built-ins use `k` and `r` (media)
  and `p`, `h`, `l`, `e`, Esc, ⌘Z and ⌘Y (drawing).
  `presio.commands.shortcut(command)` gives the key the presenter has for one
  ("E", "⌘Z", or null), to show in a tooltip.
- `contributes.panels` — dashboard cards for the `panel` surface.
- `contributes.status` — reserved: small text in the controller's header.
- `contributes.settings` — settings Presio shows under the plugin in
  **Settings → Plugins** and stores in the presenter's settings file as
  `<plugin id>.<name>` (e.g. `alice/hello.greeting`). Types: `boolean`, `number`
  (`minimum`, `maximum`; a `null` default makes it optional), `string`
  (`maxLength`), `enum` (`values`, optional `labels`). Every setting needs a
  `default` that fits it. Viewers run with the presenter's values.

## Trust and the frame

Plugins are trusted code, as VS Code extensions are: a presenter should only
install plugins they trust. Each surface runs in its own frame on Presio's
origin, with the network available — fetch, scripts, images, and players such
as YouTube or Vimeo all work. The frame is there for a stable API and to keep
a misbehaving plugin from breaking the page, not as a sandbox.

Audiences are protected differently: on a deployment with a viewer origin
(e.g. `viewer.presio.ch`), viewer surfaces run there, where nothing of an
audience member's own Presio account is stored.

## Files and loading

The manifest's `main` page is written into the frame with its document base
set to the plugin's own folder (`presio.plugin.baseUrl`), so its scripts, styles,
images and any chunks it imports load from your server with ordinary relative
URLs. Split what only some surfaces need into separate chunks (a dynamic
`import()`), so viewers download only the code their surface runs — e.g. a
PDF library used only for a download.

Nothing goes through Presio's server: every device loads the plugin from its
URL directly, like a web page, so your server must send CORS headers (and
should cache hashed files). The presenter publishes the plugin's URL and the
SHA-256 of its `main` page; a viewer only runs the plugin if the page it
loads matches, so everyone runs the same version. Built-in plugins are served
by Presio itself, on the app and viewer origins alike.

The same file runs on every surface; branch on `presio.surface`. Keys pressed
while a frame has focus (after a click on one of its buttons) are handed on to
Presio unless the plugin calls `preventDefault()` or they were typed into a
field, so the presenter's shortcuts keep working; a key Presio acts on (Space
for the next slide) no longer also presses the focused button.

## The `presio` API

Every call travels over a MessagePort as `{ v: 1, kind: "call" | "result" |
"error" | "event", id?, method, params }`. A failed call rejects with an
Error whose `code` is `MethodNotFound`, `PermissionDenied`, `InvalidParams`,
`Unavailable` or `Internal`.

```js
presio.apiVersion       // 1
presio.supports(cap)    // what this Presio can do, e.g. presio.supports("audience")
presio.plugin           // { id, name, displayName, version, baseUrl }
presio.surface          // "background" | "panel" | "viewerSheet" | "viewer" | "slide"
presio.panel            // panel surface: which contributes.panels entry; else null
presio.role             // "presenter" | "audience"
presio.theme            // "light" | "dark" (the app's theme)
presio.session          // { id, local, joinUrl } — joinUrl is null for a local deck
presio.slide.current    // 1-based slide on this device
presio.slide.total
presio.slide.onChange(slide => {})         // → unsubscribe()
presio.onContextChange(presio => {})       // session/role/theme or shortcuts changed

presio.messages.send(type, payload, { retain, volatile })  // message the plugin's other instances
presio.messages.onMessage(({ type, payload, from, sender }) => {})

presio.settings.get(name)                  // this plugin's setting (presenter's value)
presio.settings.all
presio.settings.set(name, value)           // presenter: → Promise, as if changed in Settings
presio.settings.onChange(settings => {})

presio.storage.get(key)                    // presenter: this plugin's state for this session
presio.storage.set(key, value)             // JSON, 16 KB per plugin; set(key) removes
presio.storage.all
presio.storage.onChange(storage => {})     // another surface of this plugin changed it

presio.commands.register(id, args => result)  // handle a command; buttons pass { file } or { menuItem }
presio.commands.execute("<plugin id>.<command>", args)  // → Promise of the handler's result (on this device)
presio.commands.shortcut(id)               // the presenter's key for a command: "E", "⌘Z" or null
presio.ui.setButton(command, { active, label, disabled, menu })  // update its buttons (replaces the last call)
                                           // menu: [{ id, label, checked?, disabled? } | { heading } | { separator: true }]

presio.deck.attachments()   // → Promise<[{ filename, bytes: Uint8Array }]> ("deck" permission)
presio.deck.bytes()         // → Promise<Uint8Array>, the PDF itself ("deck")
presio.deck.pages()         // → Promise<[{ width, height }]>, each page's size in PDF points ("deck")
presio.deck.save(bytes)     // presenter: → Promise; same pages, saved where the deck lives ("editDeck")
presio.deck.onChange(kind => {})  // the deck was swapped: "edit" (same pages, e.g. notes saved) or "replace"
presio.deck.onExport(async (bytes, { mode }) => bytes)  // transform the PDF this device downloads
presio.ui.setVisible(bool)  // viewer surface: show/hide the layer
presio.ui.setInteractive(true | false | "pen" | [{ x, y, w, h }])  // slide surface: take input (fractions of the surface)
                                           // in areas, touches arrive forwarded: pointer events sent to the element
                                           // touched (setPointerCapture throws for them; wrap it), a tap as a click
presio.ui.view              // slide surface: { x, y, w, h, scale } — the part of it on screen, and its zoom
presio.ui.onViewChange(view => {})
presio.ui.page              // slide surface: { x, y, w, h } — where the page is in it (all of it, unless "slideSurface": "area")
presio.ui.onPageChange(page => {})
presio.ui.hovered           // slide surface, presenter: a mouse is over the slide (never for touch)
presio.ui.onHover(hovered => {})

presio.layers.set(slide, [{ x, y, w, h, image, fit }])  // still images on a slide, shown in every view
presio.layers.clear()
presio.clock.now()          // the server's clock (ms), the same on every device

const h = presio.history.open({ init, apply, snapshot?, restore? })  // the deck's edit history ("history")
h.state                     // ordered entries applied to init(), then this device's pending ops
h.confirmed                 // the ordered entries only: what every device agrees on
h.ready / h.whenReady()     // loaded (state is init() until then)
h.commit(op)                // presenter: → id; JSON, at most 16 KB; shown here at once
h.mine()                    // this device's ops, newest first: [{ id, op, seq }] (seq null while pending)
h.onChange((state, { kind, entry }) => {})  // kind: "state" | "entry" | "pending"
h.onError((id, message) => {})              // an op was refused (and dropped)
presio.blobs.put(data)      // presenter: Blob | Uint8Array | ArrayBuffer, at most 5 MB → Promise<sha256>
presio.blobs.get(sha)       // → Promise<Blob | null>, fetched only when asked for ("history")
```

Storage: `presio.storage` is the presenter's per-session state on their own
device. It survives a reload and is shared by the plugin's surfaces there
(e.g. a background and a panel), but never leaves the device — use messages
for anything viewers need. On audience devices it is empty and `set` does
nothing.

Downloads: when someone downloads the deck with everything in it (or
everything but its attachments — `mode` is `"everything"` or
`"no-attachments"`), each running plugin's `onExport` handler on that device
gets the PDF in turn, in the presenter's plugin order, and resolves to the PDF
to pass on — the place to bake in what the plugin shows live (the media plugin
draws each video's poster onto its page, the drawing plugin each stroke).
Handlers see the deck with its attachments still in. Register one handler per
plugin per device — on the presenter's, the `background` surface (or a panel)
is used first; a viewer's download uses whichever surface registered one. A
handler that throws or takes over a minute is skipped. "Original file" never
passes through plugins.

Messaging:

- From the **presenter**, a message reaches every instance of the plugin on
  every device. With `{ retain: true }` the latest message of that `type` is
  kept and replayed to devices that join later, and to the presenter's own
  page after a reload (it's saved on their device) — use it for state ("the
  code is showing"), not one-off events. A retained `null` payload forgets
  the type. `{ retain: "deck" }` is the same but belongs to the deck on
  screen: replacing the deck forgets it everywhere. Split big state over many
  types (the drawing plugin keeps each slide's strokes in a few): a plugin may
  keep up to 1024 retained types and 2 MB of them; past that, messages still
  go out live but aren't kept.
- `{ volatile: true }` lets a message be dropped instead of queued when a
  connection is backed up — for a stream where only the latest value counts
  (a laser position).
- From the **audience**, a message reaches the presenter's instances only
  (rate-limited), with `from: "audience"` and a per-connection `sender` id.
  The presenter aggregates and broadcasts results back.
- Payloads are JSON, at most 16 KB; `type` is up to 64 of `A-Za-z0-9_.:-`.

History: `presio.history` is for edits that should last — a drawing's
strokes, a board's cards. The presenter commits ops; they're put in one order
(by the server while the deck is shared, by the presenter's page for a local
deck) and every device applies the same entries in the same order, so every
copy of the state comes out the same. `apply(state, op, entry)` returns the
next state and must not change the one it's given: pending ops are applied on
top of the ordered state, and again when it moves. `entry` is `{ id, by, at,
seq, pending }`; `by` is the device that committed it (compare with
`h.device`) — undo is the plugin's own op that reverses this device's last one
(`h.mine()[0]`).

- Name the things ops change by id ("erase stroke `b7`"), not by position:
  two devices' ops then combine without conflict, and when both change the
  same thing, the later one wins.
- The history belongs to the deck: the presenter's device keeps it
  (IndexedDB) across sessions, and it starts the session's copy when the deck
  is shared. A deck replaced by one with a different page count starts a new
  history.
- Give `snapshot(state)` (JSON) and `restore(snapshot)` for a history that
  grows: every couple of hundred entries the presenter's device takes one, and
  the log starts there — devices joining later load the snapshot and what came
  after it. `h.mine()` only goes back to the latest snapshot. A plugin without
  them may keep up to 4 MB of entries.
- Blobs are content-addressed bytes for what doesn't fit in an op (images):
  put the bytes, put the hash in an op. They travel over HTTP, never the
  session's socket, and `get` fetches one only when asked — fetch what's on
  screen, not everything, and draw a placeholder until it arrives. At most
  5 MB each and 50 MB per session.

## Develop

1. Serve the folder, e.g. `npx vite --port 5174 --cors` or any static server
   that sends CORS headers.
2. In Presio, open a deck as the controller → **Settings → Plugins**, paste
   `http://localhost:5174/` and **Add**. Reload the presentation to pick up
   edits.
3. For a shared deck, open the viewer link on another device: viewers load the
   plugin from the URL the presenter added — they install nothing. So a plugin
   served on `localhost` only reaches viewers on the same machine (the viewer
   window); for phones, serve it where they can reach it. With Presio itself
   running locally over http, that can be your LAN address (`npx vite --host`,
   then add `http://<your-ip>:5174/`); a hosted Presio is https, so there it
   takes an https URL — a tunnel (e.g. `cloudflared tunnel --url
   http://localhost:5174`) or a real host.
   Reload the viewers after editing, or they'll refuse the changed plugin.

## Publish on GitHub

A public GitHub repo is all a plugin needs: put `presio-plugin.json` and its
files at the repo root (or in a folder), commit, and presenters add it as

```
you/name                          # shorthand for github:you/presio-name
github:you/presio-name            # latest release, else newest tag, else main's current commit
github:you/presio-name@v1.2.0     # a tag, branch or commit
github:you/kit@v1.2.0/plugins/poll   # the plugin in a folder (id you/poll)
```

Name the repo `presio-<name>`: its plugin's id is then `you/<name>`.

(or paste the repo's `github.com` link). Presio serves it through jsDelivr
(`https://cdn.jsdelivr.net/gh/you/your-plugin@<ref>/`) and always pins the
URL: a branch becomes the commit it's on, because viewers only run the exact
version the presenter loaded and a CDN caches a branch for hours. Tag a
release to ship an update; presenters re-add the plugin to move to it.

- A plugin with a build step must commit its built files (jsDelivr serves the
  repo, not release assets).
- `raw.githubusercontent.com` URLs only work for a single-file plugin (inline
  scripts and styles): it serves every file as `text/plain` with `nosniff`, so
  browsers won't run a separate script. Presio turns such links into jsDelivr
  ones. GitHub release downloads can't be loaded at all (no CORS).
- Private repos can't be served to viewers.

If some viewers can't load a plugin (a `localhost` URL phones can't reach, a
version that changed under its URL), the presenter sees a warning in the
controller's header, and the reason under the plugin in Settings.

Keyboard shortcuts: Presio's own (`←` `→` Space PgUp PgDn `b` `c` `j`) win,
then plugins in the order they're listed. A clashing key is flagged in the
plugin's Settings page and under Keyboard shortcuts, where the presenter can
rebind it — so pick a key Presio doesn't use.

## Example

The built-in Join Code plugin is a complete example:
[manifest](BASE/plugins/join-code/presio-plugin.json),
[index.html](BASE/plugins/join-code/index.html). The built-in Timer
([manifest](BASE/plugins/timer/presio-plugin.json)) shows a panel and a
background sharing `presio.storage`, and Speaker Notes
([manifest](BASE/plugins/notes/presio-plugin.json)) reads notes out of the PDF
and saves edits back with `presio.deck.save` — both React. Media and Drawing
load each surface's code as its own chunk, and pdf-lib only for a download.
Media ([manifest](BASE/plugins/media/presio-plugin.json)) plays the GIFs,
videos and YouTube/Vimeo embeds a deck carries: a `slide` surface with the
players (controls drawn on each item for the presenter, claimed with
`setInteractive` areas), retained messages for play state and audio plus time
samples stamped with `presio.clock.now()` that viewers follow, posters as
`presio.layers`, keybindings, and an `onExport` handler. Drawing
([manifest](BASE/plugins/drawing/presio-plugin.json)) is the pen, highlighter
and laser: a `slide` surface that takes input while a tool is active and only
its palette otherwise, strokes streamed as they're drawn and kept as
per-slide `retain: "deck"` chunks, a volatile laser, previews as
`presio.layers`, commands run from a header button and keybindings, and an `onExport` handler
that bakes the strokes into the PDF as vectors.
