// The live media on the slide, on the presenter's current slide and on every
// viewer. The presenter's copy carries the controls, drawn on each item, and
// is the one every screen follows. Viewers show no controls, except on an
// HTML animation the presenter lets them run themselves.

import { createPlayer, type Player } from "./players";
import { isEmbed, isHtml, isPlayable, isVideo, readPlacements, release, type Placement, type Placements } from "./placements";
import { poster } from "./posters";
import {
  DEFAULT_AUDIO,
  mutedHere,
  parseAudio,
  parseModes,
  parseState,
  parseTime,
  parsePageStates,
  type PageStates,
  sendState,
  type AudioState,
  type AudioTarget,
  type MediaState,
  type Modes,
} from "./protocol";
import { icon } from "./icons";

interface Item {
  p: Placement;
  el: HTMLElement;
  player: Player;
  poster: HTMLImageElement | null;
  controls: HTMLElement | null;
  /** The last command applied, by seq. */
  applied: number;
}

const AUDIO_CHOICES: { label: string; muted: boolean; target?: AudioTarget }[] = [
  { label: "Muted", muted: true },
  { label: "Presenter only", muted: false, target: "presenter" },
  { label: "Viewers only", muted: false, target: "viewers" },
  { label: "Presenter and viewers", muted: false, target: "both" },
];

// Keys an HTML animation hands back, and the deck command each one runs.
const NAV_COMMANDS: Record<string, string> = {
  ArrowRight: "presio.nextSlide",
  ArrowDown: "presio.nextSlide",
  PageDown: "presio.nextSlide",
  ArrowLeft: "presio.prevSlide",
  ArrowUp: "presio.prevSlide",
  PageUp: "presio.prevSlide",
};

export function runSlide() {
  const presenter = presio.role === "presenter";
  const root = document.getElementById("root")!;
  let placements: Placements = new Map();
  let slide = presio.slide.current;
  let items: Item[] = [];
  let state: MediaState | null = null;
  let audio: AudioState = DEFAULT_AUDIO;
  let modes: Modes = {};
  // The page states of the slide's HTML animations: the presenter's own, or
  // (viewers) the presenter's latest.
  let pages: PageStates | null = null;
  let pagesTooBig = false;
  // The audio menu, open under this item's controls.
  let menuFor: string | null = null;

  /** An HTML animation viewers run themselves, not following the presenter. */
  const independent = (p: Placement) => isHtml(p) && (modes[p.id] ?? p.sync === "independent");

  // --- Players ---

  const build = () => {
    for (const item of items) item.player.destroy();
    root.replaceChildren();
    menuFor = null;
    if (presenter) pages = { slide, states: {} };
    items = (placements.get(slide) ?? []).map((p) => {
      const el = document.createElement("div");
      el.className = "item";
      Object.assign(el.style, { left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%` });
      const item: Item = { p, el, player: null!, poster: null, controls: null, applied: 0 };
      item.player = createPlayer(p, presenter, {
        sample: presenter
          ? (t, playing) => presio.messages.send("time", { slide: p.slide, id: p.id, t, playing, sampledAt: presio.clock.now() })
          : undefined,
        changed: () => update(item),
        // The video's own controls: what they do is the presenter's command.
        acted: presenter ? (action) => act(p, action) : undefined,
        // The presenter's "Sync": every viewer running it themselves jumps
        // to this moment (and carries on from there on their own).
        syncViewers: presenter
          ? (t, playing, page) => presio.messages.send("jump", { slide: p.slide, id: p.id, t, playing, sampledAt: presio.clock.now(), state: page })
          : undefined,
        // What the presenter changed on an animation: viewers following it
        // take it on, and later ones start from it.
        state: presenter ? (page) => sharePage(p, page) : undefined,
        mutedHere: presenter ? (muted) => setAudio(nativeMute(muted)) : undefined,
        key: (key) => {
          const command = NAV_COMMANDS[key];
          if (command) void presio.commands.execute(command).catch(() => {});
        },
      });
      item.player.setIndependent?.(independent(p));
      if (!presenter && pages?.slide === slide && p.id in pages.states) item.player.setState?.(pages.states[p.id]);
      // A spinner until the player has something to show (shown after a
      // moment, so a quick load doesn't flash it).
      const spinner = document.createElement("div");
      spinner.className = "loading";
      spinner.setAttribute("role", "progressbar");
      spinner.setAttribute("aria-label", "Loading");
      el.append(spinner);
      // The poster shows until the player has something to show. An
      // animation's poster takes about as long as the animation itself, so
      // it gets the PDF's placeholder and the spinner instead.
      if (!isHtml(p)) void poster(p).then((url) => {
        if (!url || item.player.ready || !items.includes(item)) return;
        const img = document.createElement("img");
        img.className = "poster";
        img.alt = "";
        img.src = url;
        item.poster = img;
        el.prepend(img);
      });
      el.append(item.player.element);
      root.append(el);
      return item;
    });
    applyState();
    applyAudio();
    for (const item of items) update(item);
  };

  /** Act on the presenter's latest command, once per command. Before there
   *  is one for this slide, viewers start autoplay media themselves; so does
   *  everyone with an autoplay HTML animation, which plays alongside the
   *  slide's other media rather than taking turns with it. A viewer running
   *  an animation themselves takes no commands for it. */
  const applyState = () => {
    const current = state?.slide === slide ? state : null;
    for (const item of items) {
      const own = !presenter && independent(item.p);
      const forItem = !own && current && current.id === item.p.id ? current : null;
      if (!forItem) {
        const start = !presenter || isHtml(item.p);
        if (start && item.p.autoplay && item.applied === 0 && (!current || current.id === null || isHtml(item.p))) {
          item.applied = -1;
          item.player.autostart();
        }
      } else if (forItem.seq !== item.applied) {
        item.applied = forItem.seq;
        item.player.command(forItem.action, forItem.seq);
      }
    }
    for (const item of items) update(item);
  };

  const applyAudio = () => {
    const muted = mutedHere(audio);
    for (const item of items) item.player.setMuted(muted);
    for (const item of items) update(item);
  };

  // --- Presenter controls, on each item ---

  const act = (p: Placement, action: MediaState["action"]) => {
    state = sendState(slide, p.id, action, state);
    applyState();
  };

  // Unmuting here means hearing it here: a deck routed to viewers only plays
  // on both.
  const nativeMute = (muted: boolean): AudioState => {
    if (muted) return { ...audio, muted: true };
    if (presio.session.local) return { muted: false, target: "presenter" };
    return { muted: false, target: audio.target === "viewers" ? "both" : audio.target };
  };

  const setIndependent = (p: Placement, value: boolean) => {
    modes = { ...modes, [p.id]: value };
    presio.messages.send("modes", modes, { retain: true });
    applyModes();
  };

  const sharePage = (p: Placement, page: unknown) => {
    if (pages?.slide !== p.slide) return;
    pages.states[p.id] = page;
    // A message has to fit the relay's limit (16 KB).
    const big = JSON.stringify(pages).length > 15_000;
    if (big && !pagesTooBig) console.warn("[media] An animation's state is too big to share with viewers (over 15 KB).");
    pagesTooBig = big;
    if (!big) presio.messages.send("page", pages, { retain: true });
  };

  const applyModes = () => {
    for (const item of items) item.player.setIndependent?.(independent(item.p));
    applyState();
  };

  const setAudio = (next: AudioState) => {
    audio = next;
    presio.messages.send("audio", audio, { retain: true });
    menuFor = null;
    applyAudio();
  };

  const button = (name: string, title: string, onClick: () => void, className = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.dataset.testid = `media-${name}`;
    b.innerHTML = icon(name);
    b.onclick = (e) => {
      e.stopPropagation();
      onClick();
    };
    return b;
  };

  const renderControls = (item: Item) => {
    const { p, player } = item;
    const bar = document.createElement("div");
    bar.className = "controls";
    // A local deck's viewer window is on this machine: audio plays here
    // only, so there's nothing to route.
    const local = presio.session.local;
    const openMenu = () => {
      menuFor = menuFor === p.id ? null : p.id;
      for (const i of items) update(i);
    };
    if (isHtml(p)) {
      // The animation's own controls (in its frame) play, pause, restart and
      // seek; here is who drives it on viewers' screens. A local deck's
      // viewer window is this machine's, so there's no one else to hand it to.
      if (!local) {
        const own = independent(p);
        bar.append(
          button(
            own ? "users" : "follow",
            own ? "Viewers control it themselves — click to have them follow you" : "Viewers follow you — click to let them control it",
            () => setIndependent(p, !own),
            own ? "on" : ""
          )
        );
      }
    } else if (isVideo(p)) {
      // A video plays, seeks and mutes from its own controls; all that's left
      // here is where a synced deck's audio plays.
      if (!local) {
        const heard = !audio.muted;
        bar.append(button(heard ? "sound" : "muted", "Play audio on…", openMenu, heard ? "on" : ""));
      }
    } else {
      if (isEmbed(p)) {
        const playing = player.playing;
        bar.append(
          button(playing ? "pause" : "play", playing ? "Pause" : "Play", () => act(p, playing ? "pause" : "play"), playing ? "on" : "")
        );
      }
      bar.append(button("restart", "Restart from the beginning", () => act(p, "reset")));
      if (isEmbed(p)) {
        const muted = audio.muted;
        bar.append(
          button(
            muted ? "muted" : "sound",
            muted ? "Unmute" : "Mute",
            () => setAudio({ muted: !muted, target: local ? "presenter" : audio.target }),
            muted ? "" : "on"
          )
        );
        if (!local) bar.append(button("chevron", "Play audio on…", openMenu, "narrow"));
      }
    }
    if (menuFor === p.id) {
      const menu = document.createElement("div");
      menu.className = "menu";
      menu.setAttribute("role", "menu");
      const heading = document.createElement("div");
      heading.className = "heading";
      heading.textContent = "Play audio on";
      menu.append(heading);
      for (const choice of AUDIO_CHOICES) {
        const selected = choice.muted ? audio.muted : !audio.muted && audio.target === choice.target;
        const option = button(selected ? "check" : "blank", choice.label, () =>
          setAudio({ muted: choice.muted, target: choice.target ?? audio.target })
        );
        option.dataset.testid = `media-audio-${choice.muted ? "muted" : choice.target}`;
        option.setAttribute("role", "menuitemradio");
        option.setAttribute("aria-checked", String(selected));
        option.insertAdjacentText("beforeend", choice.label);
        menu.append(option);
      }
      bar.append(menu);
    }
    item.controls?.remove();
    item.controls = bar.childElementCount ? bar : null;
    if (item.controls) item.el.append(bar);
    // Open upward when there's no room below.
    const menu = bar.querySelector<HTMLElement>(".menu");
    if (menu && menu.getBoundingClientRect().bottom > window.innerHeight) menu.classList.add("up");
  };

  // --- Redraw one item, and what of the page this frame takes input on ---

  const update = (item: Item) => {
    if (!items.includes(item)) return;
    item.el.classList.toggle("ready", item.player.ready);
    if (item.player.ready) item.el.querySelector(":scope > .loading")?.remove();
    if (item.player.ready && item.poster) {
      item.poster.remove();
      item.poster = null;
    }
    if (presenter) renderControls(item);
    scheduleInteractive();
  };

  let interactiveKey = "";
  let interactiveQueued = false;
  const scheduleInteractive = () => {
    if (interactiveQueued) return;
    interactiveQueued = true;
    requestAnimationFrame(() => {
      interactiveQueued = false;
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (!width || !height) return;
      // The presenter's controls, and the videos', embeds' and animations'
      // own controls; a viewer's "tap to enable audio", and an animation
      // they run themselves.
      const targets = presenter
        ? items.flatMap((i) => [
            ...(isPlayable(i.p) ? [i.el] : []),
            ...(i.controls ? [...i.controls.children] : []),
          ])
        : [
            ...root.querySelectorAll(".tap-audio"),
            ...items.filter((i) => independent(i.p) && (i.p.controls || i.p.interactive)).map((i) => i.el),
          ];
      const regions = targets.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left / width, y: r.top / height, w: r.width / width, h: r.height / height };
      }).filter((r) => r.w > 0 && r.h > 0);
      const key = JSON.stringify(regions);
      if (key === interactiveKey) return;
      interactiveKey = key;
      presio.ui.setInteractive(regions.length ? regions : false);
    });
  };
  window.addEventListener("resize", scheduleInteractive);

  // --- Inputs ---

  presio.messages.onMessage(({ type, payload }) => {
    if (type === "state") {
      state = parseState(payload) ?? state;
      applyState();
    } else if (type === "audio") {
      audio = parseAudio(payload) ?? audio;
      applyAudio();
    } else if (type === "modes") {
      modes = parseModes(payload) ?? modes;
      applyModes();
      for (const item of items) update(item);
    } else if (type === "jump" && !presenter) {
      const time = parseTime(payload);
      const item = time?.slide === slide ? items.find((i) => i.p.id === time.id) : undefined;
      if (time && item && independent(item.p)) item.player.jump?.(time, (payload as { state?: unknown }).state ?? null);
    } else if (type === "page" && !presenter) {
      pages = parsePageStates(payload) ?? pages;
      if (pages?.slide === slide) {
        for (const item of items) if (item.p.id in pages.states) item.player.setState?.(pages.states[item.p.id]);
      }
    } else if (type === "time" && !presenter) {
      const time = parseTime(payload);
      const item = time?.slide === slide ? items.find((i) => i.p.id === time.id) : undefined;
      if (time && item && !independent(item.p)) item.player.follow(time);
    }
  });

  presio.slide.onChange(({ current }) => {
    if (current === slide) return;
    slide = current;
    build();
  });

  const load = async () => {
    let next: Placements;
    try {
      next = await readPlacements();
    } catch {
      return;
    }
    const prev = placements;
    placements = next;
    build();
    release(prev);
  };
  presio.deck.onChange(load);
  void load();
}
