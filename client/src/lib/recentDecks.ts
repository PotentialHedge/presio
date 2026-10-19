// The home page's list of recent presentations: everything this browser could
// control, gathered from IndexedDB, stored controller credentials and the
// signed-in account.

import { idbList } from "@/lib/localStore";
import { lsRemove } from "@/lib/storage";
import { supabase } from "@/lib/supabaseClient";

// One row in the recents list: everything this browser could control. Local
// decks come from IndexedDB; synced ones are discovered through the controller
// credentials this browser holds (created+synced here, or taken over via
// passphrase) — the IndexedDB record is deleted on claim, so without the
// credential scan a shared deck would vanish from the list. Account decks come
// from the signed-in user's server-side list, so they show up on any device
// they sign in on, with the controller token the server legitimately holds.
export interface RecentDeck {
  id: string;
  filename: string;
  totalSlides: number;
  /** Present only for local decks (IndexedDB creation time). */
  createdAt: number | null;
  /** Local decks only: SHA-256 of the stored PDF's bytes, when known — lets a
   * re-drop be recognised as byte-identical without touching the blob. */
  sha256?: string;
  kind: "local" | "synced" | "account";
  /** Account decks only: the controller token returned by /api/sessions/mine. */
  controllerToken?: string;
}

const SESSION_KEY_RE = /^session_([A-Z0-9]{6})$/;

async function listControlledSynced(): Promise<RecentDeck[]> {
  // Every probe below has to time out before the next one starts, so offline
  // this scan turns a page that has all its local decks in hand into a page
  // that sits there. The decks it finds are server-hosted and unreachable
  // anyway, so skip it rather than wait it out.
  if (!navigator.onLine) return [];
  const ids: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const m = key.match(SESSION_KEY_RE);
      if (m && localStorage.getItem(key)?.includes("controllerToken")) ids.push(m[1]);
    }
  } catch {
    return []; // storage unavailable (private mode): nothing to scan
  }
  const out: RecentDeck[] = [];
  // A browser only controls a handful of decks; a small sequential scan keeps
  // this trivial and ordered by insertion (most recent credential first).
  for (const id of ids.slice(0, 20)) {
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) {
        // Ended or expired server-side: the stored credential is dead weight.
        lsRemove(`session_${id}`);
        continue;
      }
      const s = await res.json();
      if (s.local) continue; // local rows are listed from IndexedDB above
      out.push({
        id,
        filename: s.filename,
        totalSlides: s.total_slides,
        createdAt: null,
        kind: "synced",
      });
    } catch {
      // Offline or server unreachable: skip rather than block the page.
    }
  }
  return out;
}

// Decks the signed-in account owns server-side. Anonymous visitors must make
// zero extra network round-trips, so the fetch is skipped entirely when no
// session token exists — signing out drops the list back to local-only for free.
async function listAccountSynced(): Promise<RecentDeck[]> {
  // Same reasoning as above, plus getSession() itself auto-refreshes a
  // near-expiry token — a network round trip before the fetch even starts.
  if (!navigator.onLine) return [];
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return [];
  try {
    const res = await fetch("/api/sessions/mine", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as {
      id: string;
      filename: string;
      total_slides: number;
      controllerToken: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      totalSlides: row.total_slides,
      createdAt: null,
      kind: "account",
      controllerToken: row.controllerToken,
    }));
  } catch {
    return []; // offline or server unreachable: skip rather than block the page
  }
}

/** This browser's own decks, from IndexedDB. */
async function listLocal(): Promise<RecentDeck[]> {
  return idbList()
    .then((rs) =>
      rs.map<RecentDeck>((r) => ({
        id: r.id,
        filename: r.filename,
        totalSlides: r.totalSlides,
        createdAt: r.createdAt,
        sha256: r.sha256,
        kind: "local",
      }))
    )
    .catch(() => []);
}

/**
 * Every deck this browser could control. Locals first (they carry a creation
 * date), then synced decks this browser holds credentials for, then the
 * account's remaining synced decks (visible from any device); deduped by id,
 * preferring the earlier kind — local > locally-controlled synced > account-only.
 */
export async function listRecentDecks(): Promise<RecentDeck[]> {
  // Independent lookups: the credential scan hits /api/sessions/:id per
  // stored token, the account list is a single call. Running them together
  // keeps the slower one off the critical path.
  const [locals, controlled, account] = await Promise.all([listLocal(), listControlledSynced(), listAccountSynced()]);
  const byId = new Map<string, RecentDeck>();
  for (const deck of [...locals, ...controlled, ...account]) {
    if (!byId.has(deck.id)) byId.set(deck.id, deck);
  }
  return [...byId.values()];
}

export function formatRecentDate(ts: number): string {
  const d = new Date(ts);
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}
