import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { useAuth } from "@/hooks/useAuth";

// Shown when the user arrives via a password-reset email link (the recovery
// session signs them in temporarily); they must pick a new password here.
// Mounted globally in App so the link works no matter which page it returns to.
export function PasswordRecoveryDialog() {
  const { passwordRecovery, updatePassword, clearPasswordRecovery, authLinkError, clearAuthLinkError } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // A dead email link (expired or already used) redirects here with only an
  // error in the fragment — explain it instead of silently showing the page.
  if (!passwordRecovery && authLinkError) {
    return (
      <DialogOverlay onClose={clearAuthLinkError} maxWidth="max-w-xs">
        <div className="space-y-3 text-center">
          <h2 className="text-lg font-semibold">Link didn't work</h2>
          <p className="text-sm text-muted-foreground">{authLinkError}</p>
          <p className="text-xs text-muted-foreground">
            Request a new link and use it soon — links are single-use.
          </p>
          <Button className="w-full" variant="outline" onClick={clearAuthLinkError}>
            Close
          </Button>
        </div>
      </DialogOverlay>
    );
  }

  if (!passwordRecovery) return null;

  const submit = async () => {
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await updatePassword(password);
      clearPasswordRecovery();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to set password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <DialogOverlay onClose={clearPasswordRecovery} maxWidth="max-w-xs">
      <div className="space-y-1 text-center">
        <h2 className="text-lg font-semibold">Set a new password</h2>
        <p className="text-xs text-muted-foreground">
          You followed a password-reset link. Choose a new password for your account.
        </p>
      </div>
      <div className="space-y-2">
        <input
          type="password"
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          autoComplete="new-password"
          autoFocus
        />
        <input
          type="password"
          placeholder="Repeat new password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && password && confirm) submit(); }}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          autoComplete="new-password"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button className="w-full" disabled={!password || !confirm || loading} onClick={submit}>
          {loading ? "Please wait…" : "Set password"}
        </Button>
      </div>
    </DialogOverlay>
  );
}
