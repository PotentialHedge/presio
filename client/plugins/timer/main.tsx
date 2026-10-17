// The talk timer. Two surfaces, both on the presenter's device only:
//  - panel: the dashboard card, with Start/Stop and Reset;
//  - background: keeps the bottom-bar button's label on the current time and
//    starts/stops the timer from it — the timer's handle on a phone, whose
//    dashboard has no room for the card.
// The clock itself lives in presio.storage, so it survives a reload and the
// two surfaces always agree.

import { useCallback, useEffect } from "react";
import { mount, useNow, usePresio, useStorage } from "../sdk/react";
import "./timer.css";

interface Clock {
  running: boolean;
  startedAt: number | null;
  /** Seconds counted before `startedAt`. */
  accumulated: number;
}

const STOPPED: Clock = { running: false, startedAt: null, accumulated: 0 };

/** A stored clock, or a stopped one when there's none (or it's malformed). */
function asClock(value: unknown): Clock {
  const c = value as Clock | undefined;
  return c && typeof c.accumulated === "number" ? c : STOPPED;
}

function elapsedOf(c: Clock, now: number): number {
  return c.running && c.startedAt ? c.accumulated + Math.floor((now - c.startedAt) / 1000) : c.accumulated;
}

function toggled(c: Clock): Clock {
  return c.running
    ? { running: false, startedAt: null, accumulated: elapsedOf(c, Date.now()) }
    : { ...c, running: true, startedAt: Date.now() };
}

/** The clock, and its controls. Read fresh from storage when acted on, so a
 *  press from the other surface is never undone by a stale copy. */
function useClock(): { clock: Clock; toggle: () => void; reset: () => void } {
  const [stored, setStored] = useStorage<Clock>("clock");
  const toggle = useCallback(() => setStored(toggled(asClock(presio.storage.get("clock")))), [setStored]);
  const reset = useCallback(() => setStored(STOPPED), [setStored]);
  return { clock: asClock(stored), toggle, reset };
}

const toSeconds = (minutes: unknown) => (typeof minutes === "number" ? Math.round(minutes * 60) : 0);

// What to display, and how far into the warning zone we are (0 = none,
// ramping to 1 = fully overdue).
function readout(elapsed: number): { seconds: number; warning: number } {
  const threshold = toSeconds(presio.settings.get("warningMinutes"));
  const duration = toSeconds(presio.settings.get("durationMinutes"));
  if (presio.settings.get("mode") === "down" && duration) {
    const remaining = Math.max(0, duration - elapsed);
    if (remaining === 0) return { seconds: 0, warning: 1 };
    if (threshold > 0 && remaining <= threshold) return { seconds: remaining, warning: 1 - remaining / threshold };
    return { seconds: remaining, warning: 0 };
  }
  if (threshold > 0 && elapsed >= threshold) {
    // Ramp to full red over the minute after the warning point.
    return { seconds: elapsed, warning: Math.min(1, (elapsed - threshold) / 60) };
  }
  return { seconds: elapsed, warning: 0 };
}

const pad = (n: number) => String(n).padStart(2, "0");

function formatTime(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function Panel() {
  usePresio();
  const now = useNow();
  const { clock: c, toggle, reset } = useClock();
  const { seconds, warning } = readout(elapsedOf(c, now));
  const time = new Date(now);
  return (
    <div className="timer">
      <span
        className="elapsed"
        data-testid="timer-elapsed"
        style={warning > 0 ? { color: `hsl(${(1 - warning) * 30}, 90%, 50%)` } : undefined}
      >
        {formatTime(seconds)}
      </span>
      {presio.settings.get("showClock") === true && (
        <span className="clock" data-testid="timer-clock">
          {pad(time.getHours())}:{pad(time.getMinutes())}:{pad(time.getSeconds())}
        </span>
      )}
      <div className="row">
        <button className="outline" onClick={toggle}>{c.running ? "Stop" : "Start"}</button>
        <button onClick={reset}>Reset</button>
      </div>
    </div>
  );
}

function ToolbarButton() {
  usePresio();
  const now = useNow();
  const { clock: c, toggle } = useClock();
  const label = formatTime(readout(elapsedOf(c, now)).seconds);
  useEffect(() => presio.commands.register("toggle", toggle), [toggle]);
  // Only tell Presio when the button actually changes, not every tick.
  useEffect(() => presio.ui.setButton("toggle", { label, active: c.running }), [label, c.running]);
  return null;
}

mount(presio.surface === "panel" ? <Panel /> : <ToolbarButton />);
