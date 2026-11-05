// One player per media item on the slide: a GIF, a <video>, or a YouTube /
// Vimeo embed. The presenter's players are the source of truth — they act on
// the presenter's commands and report where they are (a time sample, stamped
// with the server clock); viewers' players act on the same commands and then
// follow those samples to stay in time.

import { embedSrc, loadVimeoApi, loadYouTubeApi, pause, play, seek, setMuted, YT_STATE, type EmbedPlayer } from "./embeds";
import { isEmbed, isVideo, type Placement } from "./placements";

export type Action = "play" | "pause" | "reset";

/** Where the presenter's player was, and when (server clock, ms). */
export interface TimeSync {
  t: number;
  playing: boolean;
  sampledAt: number;
}

export interface PlayerHooks {
  /** Presenter: report where this item is now. */
  sample?: (t: number, playing: boolean) => void;
  /** It became ready, started or stopped, or wants a tap — redraw around it. */
  changed: () => void;
  /** Presenter: played or paused from its own controls, not by a command. */
  acted?: (action: "play" | "pause") => void;
  /** Presenter: muted or unmuted from its own controls. */
  mutedHere?: (muted: boolean) => void;
}

export interface Player {
  /** Fills the item's box. */
  readonly element: HTMLElement;
  /** Showing something (the poster underneath can go). */
  readonly ready: boolean;
  readonly playing: boolean;
  /** A presenter's command aimed at this item. `seq` is unique per command. */
  command(action: Action, seq: number): void;
  /** Viewer, on arriving at the slide before the presenter said anything:
   *  start autoplay media on its own. */
  autostart(): void;
  /** Viewer: stay in time with the presenter. */
  follow(sync: TimeSync): void;
  setMuted(muted: boolean): void;
  destroy(): void;
}

// How often the presenter reports a playing video. Frequent samples keep each
// viewer correction small enough that it never needs a hard re-seek.
const SAMPLE_MS = 250;
// ...and a paused one, which only matters to viewers that just arrived.
const PAUSED_SAMPLE_MS = 2000;

const noop = () => {};

/** Where the presenter "is" now: a playing sample plus its time in transit. */
function expectedTime(sync: TimeSync): number {
  const latency = Math.max(0, (presio.clock.now() - sync.sampledAt) / 1000);
  return sync.playing ? sync.t + latency : sync.t;
}

export function createPlayer(p: Placement, presenter: boolean, hooks: PlayerHooks): Player {
  if (isEmbed(p)) return new Embed(p, presenter, hooks);
  if (isVideo(p)) return new Video(p, presenter, hooks);
  return new Gif(p, hooks);
}

function box(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `player ${className}`;
  return el;
}

/** A GIF (or still image). It animates by itself; "restart" reloads it. */
class Gif implements Player {
  readonly element = box("image");
  ready = false;
  readonly playing = false;
  private img = document.createElement("img");
  private p: Placement;

  constructor(p: Placement, hooks: PlayerHooks) {
    this.p = p;
    this.img.alt = "";
    this.img.draggable = false;
    this.img.onload = () => {
      this.ready = true;
      hooks.changed();
    };
    this.img.src = p.src;
    this.element.append(this.img);
  }

  command(action: Action, seq: number) {
    // A new URL makes the browser decode the GIF again, from its first frame.
    if (action === "reset") this.img.src = `${this.p.src}#n=${seq}`;
  }

  autostart() {}
  follow() {}
  setMuted() {}

  destroy() {
    this.img.onload = null;
    this.img.removeAttribute("src");
  }
}

/** A video file (from the PDF, or a URL). The presenter's has the browser's
 *  own controls; viewers' have none and only follow. */
class Video implements Player {
  readonly element = box("video");
  ready = false;
  private v = document.createElement("video");
  private muted = true;
  // Smoothed drift from the presenter (s), or null to start afresh.
  private drift: number | null = null;
  private timer = 0;
  private sample: (t: number, playing: boolean) => void;
  private lastSample = { at: 0, t: -1 };
  // Whether the last command asked it to play, so a play or pause that no
  // command asked for is known to come from its own controls.
  private commanded = false;

  constructor(p: Placement, presenter: boolean, hooks: PlayerHooks) {
    const v = this.v;
    v.muted = true;
    v.playsInline = true;
    v.loop = p.loop;
    v.preload = "auto";
    v.src = p.src;
    v.addEventListener("loadeddata", () => {
      this.ready = true;
      hooks.changed();
    });
    v.addEventListener("play", () => this.played(true, hooks));
    v.addEventListener("pause", () => this.played(false, hooks));
    if (presenter) {
      v.controls = true;
      v.disablePictureInPicture = true;
      v.setAttribute("controlslist", "nodownload noremoteplayback noplaybackrate");
      // A seek from the scrubber reaches viewers at once.
      v.addEventListener("seeked", () => this.report(v.currentTime, !v.paused));
      // Its mute is the deck's audio.
      v.addEventListener("volumechange", () => {
        if (v.muted !== this.muted) hooks.mutedHere?.(v.muted);
      });
      // While it plays, keys are the player's (Space pauses, arrows seek);
      // paused, they are the deck's again.
      v.addEventListener("keydown", (e) => {
        if (!v.paused && e.key !== "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
      });
    }
    // Rate trimming should sound like a tape, not a vocoder.
    v.preservesPitch = false;
    this.element.append(v);

    this.sample = hooks.sample ?? noop;
    if (presenter && hooks.sample) {
      this.timer = window.setInterval(() => {
        if (v.readyState < 1) return;
        const now = Date.now();
        const idle = v.paused && v.currentTime === this.lastSample.t && now - this.lastSample.at < PAUSED_SAMPLE_MS;
        if (!idle) this.report(v.currentTime, !v.paused);
      }, SAMPLE_MS);
    }
  }

  get playing() {
    return !this.v.paused;
  }

  private played(playing: boolean, hooks: PlayerHooks) {
    const v = this.v;
    if (playing !== this.commanded) {
      this.commanded = playing;
      hooks.acted?.(playing ? "play" : "pause");
    }
    this.report(v.currentTime, playing);
    // Paused (or at its end), hand the keyboard back to the deck.
    if (!playing && v.controls && document.hasFocus()) {
      v.blur();
      (window.frameElement as HTMLElement | null)?.blur();
    }
    hooks.changed();
  }

  private report(t: number, playing: boolean) {
    this.lastSample = { at: Date.now(), t };
    this.sample(t, playing);
  }

  autostart() {
    this.commanded = true;
    this.v.currentTime = 0;
    this.v.play().catch(noop);
  }

  // Acting on a command also reports at once, so viewers don't wait for the
  // next tick.
  command(action: Action) {
    const v = this.v;
    this.drift = null;
    if (action === "play") {
      this.commanded = true;
      v.play().catch(noop);
      this.report(v.currentTime, true);
    } else if (action === "pause") {
      this.commanded = false;
      v.pause();
      this.report(v.currentTime, false);
    } else {
      const wasPlaying = !v.paused;
      this.commanded = wasPlaying;
      v.currentTime = 0;
      if (wasPlaying) v.play().catch(noop);
      this.report(0, wasPlaying);
    }
  }

  // Follow the presenter:
  //  1. Compare against where the presenter is *now* (expectedTime).
  //  2. Smooth the drift (EWMA) so per-sample jitter from the network and the
  //     browser doesn't flap playbackRate — the audible "warble".
  //  3. Correct by trimming the rate, audio-aware: muted, aggressively
  //     (±10 %); audible, within ±2 % so nobody hears it, converging slower.
  //  4. Re-seek only past a hard limit, as a backstop.
  follow(sync: TimeSync) {
    const v = this.v;
    this.commanded = sync.playing;
    if (sync.playing && v.paused) v.play().catch(noop);
    else if (!sync.playing && !v.paused) v.pause();

    const expected = expectedTime(sync);
    const raw = v.currentTime - expected;
    // Reseed on a jump (a seek, a restart) so the filter converges at once.
    const prev = this.drift;
    const smoothed = prev === null || Math.abs(raw - prev) > 1 ? raw : prev * 0.7 + raw * 0.3;
    this.drift = smoothed;

    if (Math.abs(smoothed) > 2) {
      v.playbackRate = 1;
      v.currentTime = Math.max(0, expected);
      this.drift = null;
      return;
    }

    const audible = !this.muted;
    const DEAD = audible ? 0.15 : 0.05;
    const K = audible ? 0.05 : 0.4;
    const RATE_MIN = audible ? 0.98 : 0.9;
    const RATE_MAX = audible ? 1.02 : 1.1;
    // A soft dead zone: only the drift beyond DEAD is corrected, so the rate
    // ramps up smoothly from exactly 1 rather than stepping at the edge.
    let rate = 1;
    if (sync.playing) {
      const excess = Math.max(0, Math.abs(smoothed) - DEAD);
      rate = Math.max(RATE_MIN, Math.min(RATE_MAX, 1 - K * Math.sign(smoothed) * excess));
    }
    if (Math.abs(rate - 1) < 0.005) rate = 1;
    if (Math.abs(v.playbackRate - rate) > 0.002) v.playbackRate = rate;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.v.muted = muted;
  }

  destroy() {
    clearInterval(this.timer);
    this.v.pause();
    this.v.removeAttribute("src");
    this.v.load();
  }
}

type Intent = { type: "command"; action: Action } | { type: "autostart" } | null;

/**
 * A YouTube or Vimeo embed, driven through its SDK. The presenter's shows the
 * provider's own controls (seeking there reaches viewers through the time
 * samples); viewers' show none and only follow.
 */
class Embed implements Player {
  readonly element = box("embed");
  ready = false;
  private iframe = document.createElement("iframe");
  private p: Placement;
  private presenter: boolean;
  private hooks: PlayerHooks;
  private sdk: EmbedPlayer | null = null;
  private destroyed = false;
  private timer = 0;
  // What was asked of it before the SDK was ready, applied once it is.
  private intent: Intent = null;
  private pendingSync: TimeSync | null = null;
  // The last play/pause issued to the SDK. Repeated playVideo() calls on an
  // unmuted YouTube player freeze its decoder, so only changes are sent.
  private issued: boolean | null = null;
  // Vimeo's API is promise-based; its events keep this for synchronous reads.
  private vimeoState = { t: 0, playing: false };
  private muted = true;
  // Browsers won't let a remote message unmute a viewer's embed (YouTube
  // pauses instead): that takes a tap on the viewer's own screen.
  private audioAllowed: boolean;
  private tap: HTMLButtonElement | null = null;

  constructor(p: Placement, presenter: boolean, hooks: PlayerHooks) {
    this.p = p;
    this.presenter = presenter;
    this.hooks = hooks;
    this.audioAllowed = presenter;
    const f = this.iframe;
    f.src = embedSrc(p, presenter);
    f.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
    f.allowFullscreen = true;
    f.title = p.kind === "youtube" ? "YouTube video" : "Vimeo video";
    this.element.append(f);
    void this.attach();
    if (presenter && hooks.sample) {
      this.timer = window.setInterval(() => this.report(), SAMPLE_MS);
    }
  }

  get playing(): boolean {
    const s = this.sdk;
    if (!s || !this.ready) return false;
    return s.kind === "youtube" ? s.player.getPlayerState() === YT_STATE.PLAYING : this.vimeoState.playing;
  }

  /** It needs a tap before its sound can play here. */
  get wantsTap(): boolean {
    return !this.presenter && !this.muted && !this.audioAllowed;
  }

  private async attach() {
    try {
      if (this.p.kind === "youtube") {
        const YT = await loadYouTubeApi();
        if (this.destroyed) return;
        const player = new YT.Player(this.iframe, {
          events: {
            onReady: () => this.onReady(),
            // Play, pause and seeks (YouTube goes PAUSED → PLAYING around
            // one): report at once rather than on the next tick.
            onStateChange: () => {
              if (!this.ready) return;
              this.report();
              this.hooks.changed();
            },
          },
        });
        this.sdk = { kind: "youtube", player };
      } else {
        const Player = await loadVimeoApi();
        if (this.destroyed) return;
        const player = new Player(this.iframe);
        this.sdk = { kind: "vimeo", player };
        player.on("timeupdate", (data) => {
          if (data) this.vimeoState.t = data.seconds;
        });
        for (const [event, playing] of [["play", true], ["pause", false], ["seeked", null]] as const) {
          player.on(event, (data) => {
            this.vimeoState = { t: data?.seconds ?? this.vimeoState.t, playing: playing ?? this.vimeoState.playing };
            this.report();
            this.hooks.changed();
          });
        }
        await player.ready();
        if (!this.destroyed) this.onReady();
      }
    } catch {
      // The SDK didn't load: the bare embed still shows, with its URL's
      // playback options, and the presenter can use its own controls.
      this.ready = true;
      this.hooks.changed();
    }
  }

  private onReady() {
    if (this.destroyed) return;
    this.ready = true;
    this.applyMute();
    const intent = this.intent;
    if (intent?.type === "autostart") this.setPlaying(true);
    else if (intent?.type === "command") this.command(intent.action);
    if (this.pendingSync) this.follow(this.pendingSync);
    this.report();
    this.hooks.changed();
  }

  private report() {
    const s = this.sdk;
    if (!this.presenter || !s || !this.ready || !this.hooks.sample) return;
    if (s.kind === "youtube") this.hooks.sample(s.player.getCurrentTime(), s.player.getPlayerState() === YT_STATE.PLAYING);
    else this.hooks.sample(this.vimeoState.t, this.vimeoState.playing);
  }

  private setPlaying(playing: boolean) {
    if (!this.sdk || !this.ready || this.issued === playing) return;
    this.issued = playing;
    if (playing) play(this.sdk);
    else pause(this.sdk);
  }

  command(action: Action) {
    this.intent = { type: "command", action };
    if (!this.sdk || !this.ready) return;
    if (action === "play") this.setPlaying(true);
    else if (action === "pause") this.setPlaying(false);
    else {
      seek(this.sdk, 0);
      this.issued = null;
    }
  }

  autostart() {
    this.intent = { type: "autostart" };
    this.setPlaying(true);
  }

  // Embeds can't trim their rate the way a <video> can, so they follow by
  // matching play/pause and re-seeking past a looser limit.
  follow(sync: TimeSync) {
    const s = this.sdk;
    if (!s || !this.ready) {
      this.pendingSync = sync;
      return;
    }
    this.setPlaying(sync.playing);
    const expected = expectedTime(sync);
    const HARD = 1.5;
    if (s.kind === "youtube") {
      if (Math.abs(s.player.getCurrentTime() - expected) > HARD) s.player.seekTo(Math.max(0, expected), true);
    } else {
      s.player.getCurrentTime().then((current) => {
        if (Math.abs(current - expected) > HARD) s.player.setCurrentTime(Math.max(0, expected)).catch(noop);
      }, noop);
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.applyMute();
    this.renderTap();
  }

  private applyMute() {
    if (this.sdk && this.ready) setMuted(this.sdk, this.muted || !this.audioAllowed);
  }

  private renderTap() {
    if (this.wantsTap && !this.tap) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tap-audio";
      button.textContent = "Tap to enable audio";
      // The click is the gesture the browser wants: unmute inside it.
      button.onclick = () => {
        this.audioAllowed = true;
        this.applyMute();
        this.renderTap();
      };
      this.tap = button;
      this.element.append(button);
      this.hooks.changed();
    } else if (!this.wantsTap && this.tap) {
      this.tap.remove();
      this.tap = null;
      this.hooks.changed();
    }
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.timer);
    const s = this.sdk;
    this.sdk = null;
    try {
      if (s?.kind === "youtube") s.player.destroy();
      else void s?.player.destroy().catch(noop);
    } catch { /* already gone */ }
  }
}
