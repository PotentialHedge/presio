import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { useAuth } from "@/hooks/useAuth";
import { lsSetString, STORAGE_KEYS } from "@/lib/storage";

export function NewsletterDialog({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const [email, setEmail] = useState(user?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const dismiss = () => {
    lsSetString(STORAGE_KEYS.newsletterStatus, "dismissed");
    onClose();
  };

  const subscribe = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to sign up");
      }
      lsSetString(STORAGE_KEYS.newsletterStatus, "subscribed");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to sign up");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <DialogOverlay onClose={onClose} maxWidth="max-w-sm">
        <div className="text-center space-y-2">
          <h2 className="text-lg font-semibold">You're on the list! 🎉</h2>
          <p className="text-sm text-muted-foreground">
            We'll let you know when new features land.
          </p>
        </div>
        <Button className="w-full" data-testid="newsletter-close" onClick={onClose}>
          Back to presenting
        </Button>
      </DialogOverlay>
    );
  }

  return (
    <DialogOverlay onClose={dismiss} maxWidth="max-w-sm">
      <div className="space-y-2 text-center">
        <h2 className="text-lg font-semibold">Enjoying Presio?</h2>
        <p className="text-sm text-muted-foreground">
          Leave your email to hear about new features. Occasional updates only —
          no spam, unsubscribe anytime.
        </p>
      </div>
      <div className="space-y-3">
        <input
          type="email"
          inputMode="email"
          placeholder="you@example.com"
          value={email}
          data-testid="newsletter-email"
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && email) subscribe(); }}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          autoFocus
        />
        {error && <p className="text-sm text-destructive text-center">{error}</p>}
        <Button className="w-full" disabled={!email || busy} data-testid="newsletter-subscribe" onClick={subscribe}>
          {busy ? "Signing up…" : "Keep me posted"}
        </Button>
        <button
          type="button"
          data-testid="newsletter-dismiss"
          onClick={dismiss}
          className="block w-full text-center text-xs text-muted-foreground hover:text-foreground underline underline-offset-4"
        >
          No thanks
        </button>
      </div>
    </DialogOverlay>
  );
}
