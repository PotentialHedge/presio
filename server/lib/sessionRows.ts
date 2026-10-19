// Shared helpers for creating `sessions` rows. Both entry points that mint a
// session — the reserve routes in routes/sessions/ and the agent handoff in
// lib/presentHandoff.ts — need the same code/passphrase alphabets, the same
// owned-session TTL, and the same collision-retrying insert. They used to carry
// verbatim copies of all four with a "keep in sync" comment; this is that
// single copy.
import { customAlphabet } from "nanoid";
import type { SupabaseClient } from "@supabase/supabase-js";

// Ambiguous glyphs (I, O, 0, 1) are left out so a code read off a projector or
// typed from a QR fallback can't be transcribed wrong.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Short, human-transcribable join code (the 6 characters viewers type). */
export const generateSessionId = customAlphabet(ALPHABET, 6);

/** Shared-control passphrase handed to a co-presenter. */
export const generatePassphrase = customAlphabet(ALPHABET, 8);

// Anonymous sessions keep the DB default expiry (24h). Sessions owned by a
// logged-in user live a week — long enough to prepare a deck days ahead.
export const OWNED_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ownedExpiry = () => new Date(Date.now() + OWNED_SESSION_TTL_MS).toISOString();

// Postgres unique-violation SQLSTATE (mirrored by local/queryBuilder.ts for
// SQLite) — the signal that the generated code collided and we should retry.
const UNIQUE_VIOLATION = "23505";

/**
 * Insert a session row, retrying with a fresh code on collision. Expired rows
 * are retained indefinitely, so the 6-char code space slowly fills and a
 * collision must be a retry, not a 500. Returns the id, or null on failure.
 */
export async function insertSession(
  supabase: SupabaseClient,
  row: Record<string, unknown>
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = generateSessionId();
    const { error } = await supabase.from("sessions").insert({ ...row, id });
    if (!error) return id;
    if (error.code !== UNIQUE_VIOLATION) {
      console.error("Failed to create session:", error);
      return null;
    }
  }
  console.error("Failed to create session: code collision after 3 attempts");
  return null;
}
