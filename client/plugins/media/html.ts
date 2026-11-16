// An HTML animation: its own document (runtime + bundle, see bundle.ts) in a
// sandboxed frame — scripts run, but on an opaque origin, with no access to
// Presio or the deck — driven over postMessage.
//
// The runtime in the frame owns the animation's clock (html-runtime.js), so
// it plays, pauses, seeks and changes speed like a video: the presenter's
// reports where it is, and viewers following the presenter trim their speed
// to stay in time, the way a <video> does. A viewer the presenter has let run
// it themselves ignores all that and gets its controls.
//
// Besides the time, the presenter's frame shares what was changed on the
// page — form fields, and whatever the page hands over with presio.sync
// (html-runtime.js) — and viewers following it take that on as it changes.

import { box, expectedTime, type Action, type Player, type PlayerHooks, type TimeSync } from "./players";
import type { Placement } from "./placements";

/** What the frame shows and lets through: its controls, whether they act in
 *  the frame or only tell us (delegate), and pointer input to the page. */
interface Ui {
  controls: boolean;
  delegate: boolean;
  interactive: boolean;
  /** The presenter's "Sync" button, while viewers run it themselves. */
  sync: boolean;
  /** Report the page's state as it changes (the presenter's). */
  share: boolean;
}

/** A page's shareable state, as html-runtime.js reads it: opaque here. */
export type PageState = unknown;

type FromFrame =
  | { type: "ready"; restored: boolean }
  | { type: "status"; t: number; playing: boolean; duration: number | null }
  | { type: "acted"; action: Action }
  | { type: "seek"; t: number }
  | { type: "key"; key: string }
  | { type: "syncViewers"; state?: PageState }
  | { type: "state"; state: PageState }
  | { type: "reload" };

export class HtmlPlayer implements Player {
  readonly element = box("html");
  ready = false;
  private iframe = document.createElement("iframe");
  private p: Placement;
  private presenter: boolean;
  private hooks: PlayerHooks;
  private ui: Ui;
  private muted = true;
  private rate = 1;
  // The frame's last report, and when it came (performance.now()).
  private st = { t: 0, playing: false, at: 0 };
  // What was asked of it before the frame was ready.
  private wantPlaying: boolean | null = null;
  private wantSeek: number | null = null;
  private pendingSync: TimeSync | null = null;
  // The last play/pause sent while following, so it's sent once per change.
  private issued: boolean | null = null;
  private drift: number | null = null;
  // Viewer: running it themselves, not following.
  private independent = false;
  // Viewer: the presenter's latest page state (undefined: none heard yet).
  private presenterState: PageState | undefined = undefined;

  constructor(p: Placement, presenter: boolean, hooks: PlayerHooks) {
    this.p = p;
    this.presenter = presenter;
    this.hooks = hooks;
    this.ui = presenter
      ? { controls: true, delegate: true, interactive: p.interactive, sync: false, share: true }
      : { controls: false, delegate: false, interactive: false, sync: false, share: false };
    const f = this.iframe;
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.allow = "autoplay";
    f.title = "Animation";
    f.srcdoc = p.srcdoc?.() ?? "";
    window.addEventListener("message", this.onMessage);
    this.element.append(f);
  }

  get playing() {
    return this.st.playing;
  }

  private send(message: Record<string, unknown>) {
    this.iframe.contentWindow?.postMessage({ presio: "html", ...message }, "*");
  }

  private onMessage = (e: MessageEvent) => {
    if (e.source !== this.iframe.contentWindow || !e.data || e.data.presio !== "html") return;
    const m = e.data as FromFrame;
    switch (m.type) {
      case "ready":
        this.ready = true;
        this.send({ cmd: "ui", ...this.ui });
        this.send({ cmd: "mute", muted: this.muted });
        if (this.rate !== 1) this.send({ cmd: "rate", rate: this.rate });
        // A reload (seeking back) restores itself; a fresh frame gets what
        // was asked of it so far.
        if (!m.restored) {
          if (this.wantSeek !== null) this.send({ cmd: "seek", t: this.wantSeek });
          if (this.wantPlaying !== null) this.send({ cmd: this.wantPlaying ? "play" : "pause" });
          this.wantSeek = null;
        }
        if (this.pendingSync) this.follow(this.pendingSync);
        this.pendingSync = null;
        // A new or reloaded page starts from its own state: the presenter's
        // goes on top.
        if (!this.presenter && !this.independent && this.presenterState !== undefined) {
          this.send({ cmd: "state", state: this.presenterState });
        }
        this.hooks.changed();
        break;
      case "status": {
        const changed = m.playing !== this.st.playing;
        this.st = { t: m.t, playing: m.playing, at: performance.now() };
        if (this.presenter) this.hooks.sample?.(m.t, m.playing);
        if (changed) this.hooks.changed();
        break;
      }
      case "acted":
        if (this.presenter && (m.action === "play" || m.action === "pause" || m.action === "reset")) {
          this.releaseKeyboard();
          this.hooks.acted?.(m.action);
        }
        break;
      case "seek":
        if (this.presenter && Number.isFinite(m.t)) {
          this.releaseKeyboard();
          this.send({ cmd: "seek", t: m.t });
        }
        break;
      case "syncViewers":
        if (this.presenter) {
          this.releaseKeyboard();
          this.hooks.syncViewers?.(this.localTime(), this.st.playing, m.state ?? null);
        }
        break;
      case "state":
        if (this.presenter) this.hooks.state?.(m.state ?? null);
        break;
      case "key":
        if (typeof m.key === "string") {
          this.releaseKeyboard();
          this.hooks.key?.(m.key);
        }
        break;
    }
  };

  /** Give the keyboard back to the deck after a click on the frame's
   *  controls, so its shortcuts (k, r, the arrows) work again. */
  private releaseKeyboard() {
    this.iframe.blur();
    (window.frameElement as HTMLElement | null)?.blur();
  }

  private setPlaying(playing: boolean) {
    this.wantPlaying = playing;
    if (this.ready) this.send({ cmd: playing ? "play" : "pause" });
  }

  command(action: Action) {
    this.drift = null;
    this.issued = null;
    if (action === "play") this.setPlaying(true);
    else if (action === "pause") this.setPlaying(false);
    else if (this.ready) this.send({ cmd: "seek", t: 0 });
    else this.wantSeek = 0;
  }

  autostart() {
    this.setPlaying(true);
  }

  /** Where the frame is now, from its last report. */
  private localTime(): number {
    const { t, playing, at } = this.st;
    return playing ? t + ((performance.now() - at) / 1000) * this.rate : t;
  }

  // Follow the presenter like a muted <video> (players.ts): match play /
  // pause, trim the speed (±10 %) against smoothed drift, and seek only past
  // a hard limit — seeking back reloads the page, so it's kept rare — or to
  // land on the presenter's frame while paused.
  follow(sync: TimeSync) {
    if (!this.ready) {
      this.pendingSync = sync;
      return;
    }
    if (this.issued !== sync.playing) {
      this.issued = sync.playing;
      this.setPlaying(sync.playing);
    }
    const expected = expectedTime(sync);
    const raw = this.localTime() - expected;
    const prev = this.drift;
    const smoothed = prev === null || Math.abs(raw - prev) > 1 ? raw : prev * 0.7 + raw * 0.3;
    this.drift = smoothed;
    // Paused, the frame on screen should be the presenter's exact one; there
    // is no playback for a seek to disturb.
    if (Math.abs(smoothed) > 1 || (!sync.playing && Math.abs(raw) > 0.05)) {
      this.setRate(1);
      this.send({ cmd: "seek", t: Math.max(0, expected) });
      this.st = { t: Math.max(0, expected), playing: this.st.playing, at: performance.now() };
      this.drift = null;
      return;
    }
    let rate = 1;
    if (sync.playing) {
      const excess = Math.max(0, Math.abs(smoothed) - 0.05);
      rate = Math.max(0.9, Math.min(1.1, 1 - 0.4 * Math.sign(smoothed) * excess));
    }
    if (Math.abs(rate - 1) < 0.005) rate = 1;
    this.setRate(rate);
  }

  private setRate(rate: number) {
    if (Math.abs(rate - this.rate) <= 0.002) return;
    // Rebase the estimate on the old rate before switching.
    this.st = { t: this.localTime(), playing: this.st.playing, at: performance.now() };
    this.rate = rate;
    if (this.ready) this.send({ cmd: "rate", rate });
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.ready) this.send({ cmd: "mute", muted });
  }

  setIndependent(independent: boolean) {
    if (this.presenter) {
      this.ui = { ...this.ui, sync: independent };
      if (this.ready) this.send({ cmd: "ui", ...this.ui });
      return;
    }
    const following = this.independent && !independent;
    this.independent = independent;
    this.ui = independent
      ? { controls: this.p.controls, delegate: false, interactive: this.p.interactive, sync: false, share: false }
      : { controls: false, delegate: false, interactive: false, sync: false, share: false };
    this.drift = null;
    this.issued = null;
    this.setRate(1);
    if (this.ready) this.send({ cmd: "ui", ...this.ui });
    // Back to following: what they changed gives way to the presenter's.
    if (following && this.ready && this.presenterState !== undefined) this.send({ cmd: "state", state: this.presenterState });
  }

  /** Viewer: the presenter's page state; taken on unless running it themselves. */
  setState(state: PageState) {
    this.presenterState = state;
    if (this.ready && !this.independent) this.send({ cmd: "state", state });
  }

  jump(sync: TimeSync, state: PageState = null) {
    if (!this.ready) return;
    const t = Math.max(0, expectedTime(sync));
    this.wantPlaying = sync.playing;
    this.send({ cmd: "jump", t, playing: sync.playing, state });
    this.st = { t, playing: sync.playing, at: performance.now() };
  }

  destroy() {
    window.removeEventListener("message", this.onMessage);
    this.iframe.srcdoc = "";
    this.iframe.remove();
  }
}
