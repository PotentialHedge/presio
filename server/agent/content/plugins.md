# Building a Presio plugin

A Presio plugin adds a feature to a live presentation: a button in the
presenter's bottom bar, a keyboard shortcut, a card on their dashboard, a
status line in the header, something on every viewer's screen or phone (a
poll to answer), or a layer on the slide itself. It is an HTML page plus a
manifest in a public GitHub repo named `presio-<name>`. Presio loads it from
there, pinned to a release tag, after the presenter agrees to trust it.

Like a VS Code extension, a plugin never edits Presio's interface: it
*declares* what it adds (commands, the buttons and keys that run them,
panels, status items, settings) and Presio draws it. Its code runs in frames
and talks to Presio only through `window.presio`.

## Build one (for agents)

You were asked to build a plugin. Do it without asking the user anything
except what the plugin should do (ask that if they haven't said). Pick a short slug
`<name>` for it (`poll`, `closed-captions`).

1. **Make the repo.** With the GitHub CLI:

   ```sh
   gh repo create presio-<name> --public --clone --description "<one line>"
   cd presio-<name>
   gh repo edit --add-topic presio-plugin
   ```

2. **Start from the template**, a complete single-file plugin (a button that
   puts a banner on every viewer screen):

   ```sh
   curl -fsSLO BASE/plugins/template/presio-plugin.json
   curl -fsSLO BASE/plugins/template/index.html
   ```

   Set `name` to `<name>`, then `displayName`, `description`, `author`, the
   `surfaces` and `permissions` it needs and what it `contributes`. Write its
   code in `index.html` (plain JS, no build step; split it into more files
   if it grows). The rest of this page is the reference; the API's types are
   at [BASE/sdk/v1/presio.d.ts](BASE/sdk/v1/presio.d.ts). Add a `README.md`
   saying what it does and the link that loads it (step 5).

3. **Check it** with the same validator Presio runs, plus the files, the tag
   and the repo's name. It says how to fix each problem:

   ```sh
   curl -fsSL BASE/plugins/check.mjs -o /tmp/presio-check.mjs
   node /tmp/presio-check.mjs . --presio BASE
   ```

4. **Release it.** The git tag is the version: `v` + `version` from the
   manifest.

   ```sh
   git add -A && git commit -m "v0.1.0"
   git tag v0.1.0
   git push -u origin HEAD && git push origin v0.1.0
   ```

   Run the checker again: it prints the link for this release.

5. **Open it**: `BASE/?plugins=<owner>/<name>@v0.1.0` (`open` on macOS,
   `xdg-open` on Linux, or give the user the link). Presio shows the user a
   trust prompt with the repo, its version and what the plugin may do; they
   choose **Install** or **Load once**, then open a deck. To open a deck for
   them at the same time, upload one with `POST BASE/api/present` (or the
   MCP tool `present_pdf`) and add `&plugins=<owner>/<name>@v0.1.0` to the
   `url` it returns.

6. **Ship changes** as new releases: bump `version`, commit, tag, push, and
   open the link with the new tag. An installed plugin also moves to a newer
   release in the same major by itself, unless it asks for more permissions.
   While iterating, `?plugins=<owner>/<name>@main` runs the newest pushed
   commit, re-checked on every page load.

Without the GitHub CLI or a GitHub account, serve the folder with CORS and
load it by URL: `npx http-server --cors -p 5174 .`, then open
`BASE/?plugins=http://localhost:5174/`. That reaches the presenter's own
browser and the viewer window on the same machine, not phones (see
[Develop](#develop)).

If the user wants a change later, edit the same repo and release the next
version. The template, the [examples](#examples) and the built-ins are all
plugins written this way.

## What a plugin is

- **Trusted code.** A plugin runs with the presenter's rights on their
  device, as an editor extension does. Presenters are told to load only
  plugins they trust, and Presio asks before running one. Don't do anything
  a user wouldn't expect from what the plugin says it does.
- **Its id comes from where it's loaded from**, not from the manifest. A
  repo `github:alice/presio-poll` (shorthand `alice/poll`) is `alice/poll`; a
  repo not named `presio-…` keeps its name (`github:alice/kit` is
  `alice/kit`); a plugin in a folder of a repo takes the folder's name; one
  served from any other URL is `url:<host>/<name>`, with `name` from its
  manifest. Built-ins are `presio/*`. Settings, keybindings, storage,
  retained messages and histories are all keyed by it.
- **One HTML page, run on each surface** it lists: hidden on the presenter's
  device (`background`), as dashboard cards (`panel`), on every viewer
  (`viewer`, `viewerSheet`) and over the slide (`slide`). `presio.surface`
  says which; `presio.role` says whether it's the presenter's device or an
  audience one.
- **Viewers install nothing.** They run what the presenter runs, and each
  viewer can switch a plugin off on their own device.

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
- `dependencies` — other plugins it needs, by source and semver range:
  `{ "github:alice/presio-quiz-core": "^1.0.0" }`. They're shown in the same
  trust prompt, load first, and run as plugins of their own; use their
  commands with `presio.commands.execute("alice/quiz-core.<command>")`.

- `surfaces` — where the plugin runs (the same HTML in each):
  - `background`: hidden, on the presenter's device, for as long as the deck
    is open. Keep state here and handle your commands.
  - `panel`: a card on the presenter's dashboard for each entry in
    `contributes.panels` (`{ "id", "title" }`); `presio.panel` says which.
    Switching the plugin on adds them; the presenter can move, resize and
    hide them like any other card.
  - `viewerSheet`: a card on each audience device for the audience to
    interact with (a poll's answers): a bottom sheet on phones, a card beside
    the slide on wide screens, under the plugin's name with a close button.
    Hidden until the plugin calls `presio.ui.setVisible(true)`; the viewer can
    close it (✕, Esc, or a drag down on a phone), which the plugin hears with
    `presio.ui.onVisibleChange`. The sheet fits the height of your page's
    `<body>` (so don't make it `height: 100%`), up to most of the screen, and
    scrolls past that. Use `presio.theme` to match the app's light or dark card.
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
  and blobs (`presio.blobs`); `"audience"` to collect each viewer's input
  (`presio.audience`). An unknown permission is an error.
- `contributes.commands` — what the plugin can do: `{ "id", "title", "icon"?,
  "category"? }`. Handle each with `presio.commands.register(id, handler)` in
  a frame (usually `background`); the handler gets the call's args and what it
  returns is the result. Buttons and keybindings run commands, the command
  palette (⌘K / Ctrl+K) lists every command a frame on the device has
  registered (under `category`, or the plugin's `displayName`, with its key),
  and other plugins can run them too:
  `presio.commands.execute("alice/poll.open", args)`. Presio's own navigation
  is there as well: `presio.nextSlide`, `presio.prevSlide`,
  `presio.firstSlide`, `presio.lastSlide` and `presio.goToSlide` with
  `{ slide }` (on a viewer they move that viewer, where it may move on its own).
- `contributes.buttons` — up to 8 buttons Presio draws natively, each running
  a `command`. `location`: `controller.toolbar` (the controller's bottom
  bar), `controller.currentSlide` (the current slide card's header, as an icon
  with the label as its tooltip), `thumbnail.context` (the slide thumbnails'
  context menu — right-click or long-press; the command runs with
  `{ slide }`), `viewer.toolbar` (a pill beside the viewer's menu button on
  every audience device; the command runs in that device's `viewerSheet`,
  `viewer` or `slide` frame, so register it there — on a phone an icon-only
  pill when it has an icon) or `settings` (under **Actions** on the plugin's
  page in Settings). `label` and `icon` default to the command's. `icon` is one of
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
- `contributes.status` — small text in the controller's header ("12 votes"):
  `{ "id", "location": "controller.header", "tooltip"? }`, up to 4. Hidden
  until the plugin sets it with `presio.ui.setStatus(id, { text, tooltip?,
  icon?, command?, args? })` from the presenter's device; a click runs
  `command` (one of the plugin's) with `args`. `null` or an empty `text`
  hides it again.
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
URL directly, like a web page (jsDelivr for a GitHub repo, which sends CORS
headers; a server of your own must send them too). The presenter publishes
the plugin's URL, pinned to a commit for GitHub, and the SHA-256 of its
`main` page; a viewer only runs the plugin if the page it loads matches, so
everyone runs the same version. Built-in plugins are served by Presio itself,
on the app and viewer origins alike.

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
presio.commands.execute("presio.goToSlide", { slide: 3 })  // Presio's: nextSlide, prevSlide, firstSlide, lastSlide, goToSlide
presio.commands.shortcut(id)               // the presenter's key for a command: "E", "⌘Z" or null
presio.ui.setButton(command, { active, label, disabled, menu })  // update its buttons (replaces the last call)
                                           // menu: [{ id, label, checked?, disabled? } | { heading } | { separator: true }]
presio.ui.setStatus(id, { text, tooltip, icon, command, args })  // a status item in the controller's header; null hides it

presio.deck.attachments()   // → Promise<[{ filename, bytes: Uint8Array }]> ("deck" permission)
presio.deck.bytes()         // → Promise<Uint8Array>, the PDF itself ("deck")
presio.deck.pages()         // → Promise<[{ width, height }]>, each page's size in PDF points ("deck")
presio.deck.save(bytes)     // presenter: → Promise; same pages, saved where the deck lives ("editDeck")
presio.deck.onChange(kind => {})  // the deck was swapped: "edit" (same pages, e.g. notes saved) or "replace"
presio.deck.onExport(async (bytes, { mode }) => bytes)  // transform the PDF this device downloads
presio.ui.setVisible(bool)  // viewer surface: show/hide the layer; viewerSheet: open/close the sheet
presio.ui.visible           // whether this frame's layer or sheet is showing
presio.ui.onVisibleChange(visible => {})  // shown or hidden — also when the viewer closes the sheet
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

presio.audience.set(key, value)     // viewer: → Promise; this viewer's own value under an open key ("audience")
                                    // JSON, at most 16 KB; null removes it; rejects ("Unavailable") when closed
presio.audience.get(key)            // viewer: its own value under a key, or null (restored after a reload)
presio.audience.state(key)          // { open }: whether the key takes viewers' values (every role)
presio.audience.onState(key?, ({ key, open }) => {})
presio.audience.onMine(key?, ({ key, value }) => {})  // viewer: its own value changed (cleared by the presenter)
presio.audience.open(key)           // presenter: → Promise; start taking values for a key
presio.audience.close(key)          // presenter: stop (values are kept)
presio.audience.clear(key)          // presenter: forget every viewer's value under it
presio.audience.all(key)            // presenter: → Promise<{ [viewerId]: value }>
presio.audience.summary(key)        // presenter: → Promise<{ total, values: [{ value, count }] }>, most common first
presio.audience.onChange(key?, ({ key, summary, changes, reset }) => {})  // presenter: a few times a second at most
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

Audience input: `presio.audience` (the `"audience"` permission) is for
collecting something from every viewer — a poll's answers, a quiz, questions.
Each viewer has one slot per key: `set` replaces its own value, so a viewer
who changes their answer is counted once. The presenter `open`s a key to take
values, `close`s it to stop (viewers see `state(key).open` go false and their
`set` rejects), and `clear`s it to start over.

- Viewers are anonymous ids, kept per browser and session, so a reload or a
  reconnect keeps a viewer's slot (and `get` gives its value back). They are
  for counting, not for knowing who someone is.
- `onChange` gives the presenter both views of a change: `summary` (identical
  values counted, compared as JSON with sorted keys — what a poll shows) and
  `changes`, `{ [viewerId]: value | null }` since the last call — what a Q&A
  list needs. They arrive batched, a few times a second at most. `reset: true`
  means the values were replaced wholesale (cleared, or re-synced after a
  reconnect): read `all(key)` again if you keep your own list.
- For a shared deck the server holds the slots, for the session, and the
  presenter's page keeps a copy that restores them after a server restart.
  For a local deck the audience is the viewer window, and the presenter's page
  holds them.
- Keys are up to 64 of `A-Za-z0-9_.:-`; a value is JSON, at most 16 KB.
  Viewers' writes are rate-limited like their messages. Only plugins with a
  `viewer`, `viewerSheet` or `slide` surface are published to viewers, so
  only they can collect input.

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

## Versions, trust and updates

- **A release is a git tag** `vX.Y.Z` equal to the manifest's `version`.
  Presio resolves the tag to its commit and loads the plugin from
  `cdn.jsdelivr.net/gh/<owner>/<repo>@<commit>/`. Content at a commit never
  changes, so the presenter and every viewer run exactly what was approved.
  Never move a tag: release a new version instead.
- **What a link can ask for**, after `@`: a tag (`@v1.2.0`), a range
  (`@^1.0.0`, the newest matching tag), a branch (`@main`: dev mode, the
  newest commit, looked up on each load and shown as `main@abc1234`) or a
  commit. With no `@`, the newest release tag, else the default branch.
- **The trust prompt** shows the repo, author, stars, last push, version and
  exactly what the plugin may do (its permissions, where it shows up, whether
  it runs on audience devices) plus its dependencies. **Install** keeps it,
  **Load once** runs it in this tab only, **Skip** doesn't run it.
- **Trust is per repo and permission set.** A newer release in the same
  major, or a new commit on a dev branch, runs without asking as long as it
  asks for nothing more. New permissions, a new major or a new dependency ask
  again and say what changed. Installed plugins look for a newer release in
  their major once a day and update by themselves; a new major is offered in
  Settings.
- **`?plugins=`** takes a comma-separated list of sources:
  `BASE/?plugins=alice/poll@v0.1.0,github:bob/presio-x`. It works on the home
  page, `/present`, a `/start/…` link and a presenter's controller (not on
  viewer pages), and is removed from the URL once read. A link to a plugin
  that's already installed and trusted just updates it to that version.
- Sources also work in **Settings → Plugins → Add plugin**:

  ```
  alice/poll                         # github:alice/presio-poll, newest release
  alice/poll@v1.2.0                  # a tag; @^1.0.0 a range; @main a branch
  github:alice/kit@v1.2.0/plugins/poll   # a plugin in a folder (id alice/poll)
  https://github.com/alice/presio-poll   # a repo's link
  http://localhost:5174/             # a dev server ("unpinned")
  ```

## Develop

The quickest loop is a pushed branch: `?plugins=<owner>/<name>@main` runs its
newest commit, so push and reload. jsDelivr may take a minute to serve a new
commit.

For a loop without pushing, serve the folder with CORS
(`npx http-server --cors -p 5174 .`, `npx vite --port 5174 --cors`) and open
`BASE/?plugins=http://localhost:5174/`. Reload the presentation to pick up
edits. Viewers load the plugin from the same URL as the presenter, so
`localhost` only reaches the viewer window on the same machine. For phones,
serve it where they can reach it: with Presio itself running locally over
http, your LAN address (`npx vite --host`, then
`http://<your-ip>:5174/`); with a hosted Presio, an https URL such as a
tunnel (`cloudflared tunnel --url http://localhost:5174`). A URL that isn't
GitHub is unpinned: viewers refuse the plugin if its page changed since the
presenter loaded it, so reload viewers after an edit.

Notes on hosting:

- A plugin with a build step must commit its built files (jsDelivr serves
  the repo, not release assets).
- Private repos can't be served to viewers.
- `raw.githubusercontent.com` links are turned into jsDelivr ones; GitHub
  release downloads can't be loaded (no CORS).
- If some viewers can't load a plugin, the presenter sees a warning in the
  controller's header and the reason under the plugin in Settings.

Keyboard shortcuts: Presio's own (`←` `→` Space PgUp PgDn `b` `c` `j`) win,
then plugins in the order they're listed. A clashing key is flagged in the
plugin's Settings page and under Keyboard shortcuts, where the presenter can
rebind it, so pick a key Presio doesn't use.

## Examples

- The [template](BASE/plugins/template/index.html)
  ([manifest](BASE/plugins/template/presio-plugin.json)): a command, a
  toolbar button, a key, a status item, a setting and a viewer layer, kept in
  step by a retained message.
- [Closed captions](https://github.com/benedict-armstrong/presio-closed-captions):
  speech recognition on the presenter's device, captions in the `slide`
  surface beside the page (`"slideSurface": "area"`), a button with a
  microphone menu, settings, and a per-viewer switch.
- [Poll](https://github.com/benedict-armstrong/presio-poll): questions from
  PDF attachments or made up live, answered in each viewer's `viewerSheet`
  through `presio.audience`, results on every screen.

The built-in Join Code plugin is a complete example too:
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
