// The live media on the slide, on the presenter's current slide and on every
// viewer. The presenter's copy carries the controls, drawn on each item, and
// is the one every screen follows; viewers never show controls.

import { createPlayer, type Player } from "./players";
import { isEmbed, isPlayable, readPlacements, release, type Placement, type Placements } from "./placements";
import { poster } from "./posters";
import {
  DEFAULT_AUDIO,
  mutedHere,
  parseAudio,
  parseState,
  parseTime,
  sendState,
  type AudioState,
  type AudioTarget,
  type MediaState,
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

export function runSlide() {
  const presenter = presio.role === "presenter";
  const root = document.getElementById("root")!;
  let placements: Placements = new Map();
  let slide = presio.slide.current;
  let items: Item[] = [];
  let state: MediaState | null = null;
  let audio: AudioState = DEFAULT_AUDIO;
  // The audio menu, open under this item's controls.
  let menuFor: string | null = null;

  // --- Players ---

  const build = () => {
    for (const item of items) item.player.destroy();
    root.replaceChildren();
    menuFor = null;
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
      });
      // The poster shows until the player has something to show.
      void poster(p).then((url) => {
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
   *  is one for this slide, viewers start autoplay media themselves. */
  const applyState = () => {
    const current = state?.slide === slide ? state : null;
    for (const item of items) {
      if (!current || current.id === null) {
        if (!presenter && item.p.autoplay && item.applied === 0) {
          item.applied = -1;
          item.player.autostart();
        }
      } else if (current.id === item.p.id && current.seq !== item.applied) {
        item.applied = current.seq;
        item.player.command(current.action, current.seq);
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
    if (isPlayable(p)) {
      const playing = player.playing;
      bar.append(
        button(playing ? "pause" : "play", playing ? "Pause" : "Play", () => act(p, playing ? "pause" : "play"), playing ? "on" : "")
      );
    }
    bar.append(button("restart", "Restart from the beginning", () => act(p, "reset")));
    if (isPlayable(p)) {
      // A local deck's viewer window is on this machine: audio plays here
      // only, so there's nothing to route.
      const local = presio.session.local;
      const muted = audio.muted;
      bar.append(
        button(
          muted ? "muted" : "sound",
          muted ? "Unmute" : "Mute",
          () => setAudio({ muted: !muted, target: local ? "presenter" : audio.target }),
          muted ? "" : "on"
        )
      );
      if (!local) {
        bar.append(button("chevron", "Play audio on…", () => {
          menuFor = menuFor === p.id ? null : p.id;
          for (const i of items) update(i);
        }, "narrow"));
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
    item.controls = bar;
    item.el.append(bar);
    // Open upward when there's no room below.
    const menu = bar.querySelector<HTMLElement>(".menu");
    if (menu && menu.getBoundingClientRect().bottom > window.innerHeight) menu.classList.add("up");
  };

  // --- Redraw one item, and what of the page this frame takes input on ---

  const update = (item: Item) => {
    if (!items.includes(item)) return;
    item.el.classList.toggle("ready", item.player.ready);
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
      // The presenter's controls, and the embeds' own controls; a viewer's
      // "tap to enable audio".
      const targets = presenter
        ? items.flatMap((i) => [
            ...(isEmbed(i.p) ? [i.el] : []),
            ...(i.controls ? [...i.controls.children] : []),
          ])
        : [...root.querySelectorAll(".tap-audio")];
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
    } else if (type === "time" && !presenter) {
      const time = parseTime(payload);
      if (time?.slide === slide) items.find((i) => i.p.id === time.id)?.player.follow(time);
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
