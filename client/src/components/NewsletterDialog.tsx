import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { GitHubIcon } from "@/components/GitHubIcon";
import { REPO_URL } from "@/components/home/links";
import { useAuth } from "@/hooks/useAuth";
import { track } from "@/lib/analytics";
import { lsSetString, STORAGE_KEYS } from "@/lib/storage";

const SHARE_TEXT = "Presio: present any PDF and control it from your phone";

function WhatsAppIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.64.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.6.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.6-.92-2.2-.24-.58-.49-.5-.67-.5h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35M12.05 21.79h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.89-9.88 2.64 0 5.12 1.03 6.99 2.9a9.82 9.82 0 0 1 2.89 6.99c0 5.45-4.44 9.88-9.88 9.88m8.41-18.3A11.82 11.82 0 0 0 12.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.88 11.88 0 0 0 5.68 1.45h.01c6.55 0 11.89-5.34 11.89-11.89 0-3.18-1.24-6.16-3.48-8.42" />
    </svg>
  );
}

function XIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.63 7.58H.48l8.6-9.83L0 1.15h7.59l5.24 6.93 6.07-6.93zm-1.29 19.5h2.04L6.48 3.24H4.3l13.31 17.41z" />
    </svg>
  );
}

// The alternative ask: no email needed, just tell a friend or star the repo.
function ShareLinks({ from }: { from: "prompt" | "subscribed" }) {
  const url = window.location.origin;
  const links = [
    { id: "github", label: "Star", title: "Star on GitHub", href: REPO_URL, Icon: GitHubIcon, testId: "newsletter-star" },
    {
      id: "whatsapp",
      label: "WhatsApp",
      title: "Share on WhatsApp",
      href: `https://wa.me/?text=${encodeURIComponent(`${SHARE_TEXT} ${url}`)}`,
      Icon: WhatsAppIcon,
      testId: "newsletter-share-whatsapp",
    },
    {
      id: "x",
      label: "Post on X",
      title: "Share on X",
      href: `https://x.com/intent/post?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(url)}`,
      Icon: XIcon,
      testId: "newsletter-share-x",
    },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {links.map(({ id, label, title, href, Icon, testId }) => (
        <a
          key={testId}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => track("newsletter-share", { target: id, from })}
          aria-label={title}
          title={title}
          data-testid={testId}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-input px-2.5 py-1.5 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </a>
      ))}
    </div>
  );
}

export function NewsletterDialog({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const [email, setEmail] = useState(user?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => { track("newsletter-shown"); }, []);

  const dismiss = () => {
    track("newsletter-dismiss");
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
      track("newsletter-subscribe", { ok: true });
      setDone(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to sign up";
      track("newsletter-subscribe", { ok: false, error: message });
      setError(message);
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
        <div className="space-y-2 text-center">
          <p className="text-xs text-muted-foreground">Know someone who'd like it? Spread the word:</p>
          <ShareLinks from="subscribed" />
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
        <div className="flex items-center gap-3 pt-1 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or share with friends
          <span className="h-px flex-1 bg-border" />
        </div>
        <ShareLinks from="prompt" />
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
