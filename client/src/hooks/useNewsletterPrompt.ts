import { useState, useEffect } from "react";
import { lsGetString, STORAGE_KEYS } from "@/lib/storage";

// How long someone should have been presenting before we dare ask for their
// email. Tests may override via the (undocumented) delay localStorage key.
const DEFAULT_DELAY_MS = 3 * 60 * 1000;

function newsletterStatus(): string {
  return lsGetString(STORAGE_KEYS.newsletterStatus);
}

// Shows a one-time email list prompt after `delayMs` of controller use.
// Subscribe or dismiss both store a flag so it never comes back.
export function useNewsletterPrompt(enabled: boolean) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled || newsletterStatus()) return;
    const override = parseInt(lsGetString(STORAGE_KEYS.newsletterDelayOverride), 10);
    const delay = Number.isFinite(override) && override > 0 ? override : DEFAULT_DELAY_MS;
    const t = setTimeout(() => {
      if (!newsletterStatus()) setOpen(true);
    }, delay);
    return () => clearTimeout(t);
  }, [enabled]);

  return { open, close: () => setOpen(false) };
}
