// What the presenter's surfaces tell every device (presio.messages.send):
//
//  - "state" (retained): the last command — which item on which slide, and
//    play / pause / reset. A new slide starts with its autoplay item playing,
//    or nothing.
//  - "audio" (retained): whether media is heard, and where.
//  - "time": a playing item's position, a few times a second, stamped with
//    the server clock, for viewers to keep in time with.

import type { Action } from "./players";

export interface MediaState {
  slide: number;
  /** The item acted on; null when nothing has been, yet, on this slide. */
  id: string | null;
  action: Action;
  /** Unique per command, so a repeated one (restart twice) still counts. */
  seq: number;
}

export type AudioTarget = "presenter" | "viewers" | "both";

export interface AudioState {
  muted: boolean;
  target: AudioTarget;
}

export interface TimeMessage {
  slide: number;
  id: string;
  t: number;
  playing: boolean;
  sampledAt: number;
}

export const DEFAULT_AUDIO: AudioState = { muted: true, target: "both" };

export function sendState(slide: number, id: string | null, action: Action, prev: MediaState | null): MediaState {
  const state: MediaState = { slide, id, action, seq: Math.max(Date.now(), (prev?.seq ?? 0) + 1) };
  presio.messages.send("state", state, { retain: true });
  return state;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function parseState(v: unknown): MediaState | null {
  if (!isRecord(v) || typeof v.slide !== "number" || typeof v.seq !== "number") return null;
  if (v.id !== null && typeof v.id !== "string") return null;
  if (v.action !== "play" && v.action !== "pause" && v.action !== "reset") return null;
  return { slide: v.slide, id: v.id, action: v.action, seq: v.seq };
}

export function parseAudio(v: unknown): AudioState | null {
  if (!isRecord(v) || typeof v.muted !== "boolean") return null;
  if (v.target !== "presenter" && v.target !== "viewers" && v.target !== "both") return null;
  return { muted: v.muted, target: v.target };
}

export function parseTime(v: unknown): TimeMessage | null {
  if (!isRecord(v) || typeof v.slide !== "number" || typeof v.id !== "string") return null;
  if (typeof v.t !== "number" || typeof v.playing !== "boolean" || typeof v.sampledAt !== "number") return null;
  return { slide: v.slide, id: v.id, t: v.t, playing: v.playing, sampledAt: v.sampledAt };
}

/** Whether media is silent on this device. A local deck's viewer window is on
 *  the presenter's own machine, so there only the presenter's plays. */
export function mutedHere(audio: AudioState): boolean {
  const presenter = presio.role === "presenter";
  if (audio.muted) return true;
  if (!presenter && presio.session.local) return true;
  if (audio.target === "both") return false;
  return audio.target === "presenter" ? !presenter : presenter;
}
