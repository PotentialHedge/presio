// Join URLs (QR codes + copyable controller/viewer links) used to be built from
// window.location.origin, which breaks a local deployment: the presenter opens
// Presio at http://localhost:3001, a phone scans the QR, and resolves localhost
// to the phone itself.
//
// A browser can't discover its own LAN address — WebRTC ICE candidates are
// deliberately obfuscated to mDNS names — but the *server* is running on the
// machine we want the address of, so it can look it up directly
// (server/lib/lanAddress.ts). Resolution therefore goes, in order:
//
//   1. An address the presenter typed here before  — they know best.
//   2. GET /api/lan-address                        — the usual answer, no input.
//   3. window.location.origin                      — hosted deploys, unchanged.
//
// Whatever wins is then *verified* by fetching it (see probeOrigin), because
// there are common ways for a plausible address to be unusable: a host firewall
// dropping the port, or an address stored on a network the presenter has since
// left. Only when that check fails does the manual field appear — so in the
// normal case nobody is asked for an IP, and when someone is asked, it's
// because there is real evidence something is wrong.
//
// None of this runs on a hosted deployment: the whole path is gated on the page
// itself being loopback, which presio.xyz never is.

import { useCallback, useEffect, useState } from "react";
import { getSetting, setSetting } from "@/lib/settings";
import { viewerOrigin } from "@/lib/origins";

/** How long to wait for a probe. A firewall DROP sends no RST, so an unguarded
 *  fetch hangs until the TCP timeout (~75s) — the difference between an instant
 *  fallback and a share dialog that looks broken. */
const PROBE_TIMEOUT_MS = 1500;

/** Let typing settle before re-probing a hand-entered address. */
const EDIT_DEBOUNCE_MS = 600;

/** Whether this hostname is only reachable from this same device. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    /^127(\.\d+){3}$/.test(hostname) ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/** Whether the share links need rewriting for other devices to reach them,
 *  i.e. the presenter is viewing Presio over localhost/loopback. */
export function needsLanOverride(): boolean {
  return typeof window !== "undefined" && isLoopbackHostname(window.location.hostname);
}

const getLanAddress = () => getSetting("share.lanAddress");

function setLanAddress(value: string) {
  setSetting("share.lanAddress", value.trim());
}

/** The origin share links should point at: the stored LAN address if the
 *  presenter set one, otherwise the page's own origin. Accepts bare hosts
 *  ("192.168.1.20", "mybox.local:3001" — protocol inherited from the current
 *  page) or full URLs; trailing slashes are stripped. */
export function lanOrigin(address = getLanAddress()): string {
  if (!address) return window.location.origin;
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(address)
    ? address
    : `${window.location.protocol}//${address}`;
  return withProto.replace(/\/+$/, "");
}

// ── Server-side detection ────────────────────────────────────────────────────

export interface LanAddressResponse {
  host?: string | null;
  origin?: string | null;
  source?: string | null;
  reason?: string | null;
}

interface OriginParts {
  protocol: string;
  port: string;
}

/**
 * Turn the server's answer into an origin.
 *
 * The server reports a host and deliberately not a port, because the port that
 * matters is the one serving *this page*: under `npm run dev` the client is on
 * Vite's port while the server is on its own, and the QR has to point at the
 * former. A host that already carries a port (only possible via an explicitly
 * configured PRESIO_PUBLIC_HOST) is taken at its word.
 */
export function composeOrigin(
  response: LanAddressResponse | null,
  { protocol, port }: OriginParts
): string | null {
  if (!response) return null;
  if (response.origin) return response.origin.replace(/\/+$/, "");
  const host = response.host?.trim();
  if (!host) return null;
  const hasPort = /:\d+$/.test(host) || host.endsWith("]");
  return `${protocol}//${host}${hasPort || !port ? "" : `:${port}`}`;
}

/** Ask the server for this machine's LAN address. Resolves to null whenever
 *  there is no usable answer, including the 404 a hosted deployment returns
 *  because the route isn't registered there at all. */
export async function fetchLanOrigin(signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch("/api/lan-address", { signal, cache: "no-store" });
    if (!res.ok) return null;
    const body: LanAddressResponse = await res.json();
    return composeOrigin(body, window.location);
  } catch {
    return null;
  }
}

let detection: Promise<string | null> | undefined;

/** The detection request, shared by every surface on the page. A controller can
 *  have the share dialog, its QR and the viewer overlay mounted at once; the
 *  answer is a property of the machine, not of the component asking. */
export function ensureLanOrigin(): Promise<string | null> {
  detection ??= fetchLanOrigin();
  return detection;
}

/**
 * Whether something is actually listening on `origin`.
 *
 * This runs in the presenter's browser, on the same machine as the server, so a
 * success does not prove a *phone* can connect — both endpoints are local. What
 * it reliably catches is the opposite, and that's what it's for: a stale address
 * from a network the presenter has left, a host firewall dropping the port (a
 * packet to one's own LAN address still traverses the INPUT chain), or a port
 * that doesn't match the page's.
 *
 * `no-cors` keeps this independent of CORS and of what the target serves — a
 * resolved promise means the connection was made, a rejection means it wasn't,
 * and the opaque response body is irrelevant either way. That matters because
 * the useful target is the page's own port, which under `npm run dev` is Vite
 * rather than anything that would answer /healthz.
 */
export async function probeOrigin(origin: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  if (typeof fetch !== "function") return true;
  try {
    await fetch(`${origin}/`, {
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an origin is worth handing to anyone else.
 *
 * A loopback origin is not: every join link and QR built from it sends the
 * scanning device back to itself. That's the state a local deployment starts
 * in, and it's the reason the share surfaces hide their links rather than
 * render a QR code that cannot work.
 */
export function isShareableOrigin(origin: string): boolean {
  try {
    return !isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** "checking" — resolving or verifying; "ok" — verified reachable; "unreachable"
 *  — we have an address but nothing answered on it; "unavailable" — no address
 *  could be determined (typically a bridged container). */
export type LanStatus = "checking" | "ok" | "unreachable" | "unavailable";

/**
 * Status is derived rather than stored: it's a pure function of what we know so
 * far, and computing it here keeps the effect free of the synchronous setState
 * that would make every input keystroke cascade an extra render.
 */
export function resolveStatus({
  override,
  typed,
  detected,
  candidate,
  probe,
}: {
  override: boolean;
  typed: string;
  detected: string | null | undefined;
  candidate: string | null;
  probe: { origin: string; reachable: boolean } | null;
}): LanStatus {
  // A page served from a host other devices can reach is reachable by
  // definition — nothing to look up, nothing to verify.
  if (!override) return "ok";
  // Still waiting on the server, with nothing typed to check in the meantime.
  if (!typed && detected === undefined) return "checking";
  if (!candidate) return "unavailable";
  if (probe?.origin !== candidate) return "checking";
  return probe.reachable ? "ok" : "unreachable";
}

interface JoinOrigin {
  origin: string;
  /** False while the best origin we have is loopback — nothing to share yet. */
  shareable: boolean;
  status: LanStatus;
  /** Present only when the page is loopback, i.e. when the field is relevant. */
  address: string;
  setAddress: (value: string) => void;
}

/**
 * Resolve the origin other devices should use, verify it, and expose the manual
 * override. Hosted deploys short-circuit: the page's own origin is by
 * definition reachable, so no request is made and the status starts at "ok".
 */
export function useLanOrigin(): JoinOrigin {
  const [override] = useState(() => needsLanOverride());
  const [address, setAddressState] = useState(() => (override ? getLanAddress() : ""));
  // undefined while the lookup is in flight, null once it came back empty.
  const [detected, setDetected] = useState<string | null | undefined>(override ? undefined : null);
  // Keyed by the origin it describes, so a result never bleeds onto the next
  // candidate: while they disagree the status is "checking" by construction.
  const [probe, setProbe] = useState<{ origin: string; reachable: boolean } | null>(null);

  const setAddress = useCallback((value: string) => {
    setAddressState(value);
    setLanAddress(value);
  }, []);

  useEffect(() => {
    if (!override) return;
    let cancelled = false;
    ensureLanOrigin().then((origin) => {
      if (!cancelled) setDetected(origin);
    });
    return () => {
      cancelled = true;
    };
  }, [override]);

  const typed = address.trim();
  const candidate = typed ? lanOrigin(typed) : (detected ?? null);

  useEffect(() => {
    if (!override || !candidate) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        probeOrigin(candidate).then((reachable) => {
          if (!cancelled) setProbe({ origin: candidate, reachable });
        });
      },
      typed ? EDIT_DEBOUNCE_MS : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [override, typed, candidate]);

  const status = resolveStatus({ override, typed, detected, candidate, probe });

  const origin = candidate ?? window.location.origin;

  return {
    // An unverified candidate is still the best guess available, so it's used
    // while probing and even when the probe failed — the presenter may know
    // something the probe can't see. The status is what drives the warning.
    origin,
    shareable: isShareableOrigin(origin),
    status,
    address,
    setAddress,
  };
}

/** Join URLs plus the LAN-address state behind them, for the share surfaces
 *  that render both the links and the field. */
export function useJoinUrls(id: string) {
  const { origin, ...rest } = useLanOrigin();
  return {
    ...rest,
    origin,
    // Audiences join on the viewer origin when the deployment has one
    // (lib/origins.ts); control always stays on the app origin. Viewer is the
    // default role, so the audience's link doesn't spell it out.
    viewerUrl: `${viewerOrigin ?? origin}/s/${id}`,
    controllerUrl: `${origin}/s/${id}?role=controller`,
  };
}

/** A single join URL, for surfaces that show a QR without the field. Comes with
 *  the verdict on whether it's worth showing at all. */
export function useJoinUrl(id: string, role: "viewer" | "controller") {
  const { origin, shareable } = useLanOrigin();
  const base = role === "viewer" ? (viewerOrigin ?? origin) : origin;
  return { url: role === "viewer" ? `${base}/s/${id}` : `${base}/s/${id}?role=${role}`, shareable };
}
