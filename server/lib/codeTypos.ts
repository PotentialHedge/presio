// Mistyped join codes. People copy a six-character code off a projector, so the
// typical miss is two neighbouring characters swapped (7DZ4VE for 7DZ4EV) or
// one character misread (7DX4EV). Both are one edit away from the real code.

/** Whether `a` and `b` (same length) differ by one substitution or one adjacent swap. */
export function isOneTypoApart(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  const diffs: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      diffs.push(i);
      if (diffs.length > 2) return false;
    }
  }
  if (diffs.length === 1) return true;
  const [i, j] = diffs;
  return j === i + 1 && a[i] === b[j] && a[j] === b[i];
}

/**
 * The one code in `codes` that `typed` is a single typo away from. Null when
 * there are none, or several: a guess between two live talks could put
 * someone in the wrong room.
 */
export function likelyIntendedCode(typed: string, codes: Iterable<string>): string | null {
  let match: string | null = null;
  for (const code of codes) {
    if (!isOneTypoApart(typed, code)) continue;
    if (match) return null;
    match = code;
  }
  return match;
}
