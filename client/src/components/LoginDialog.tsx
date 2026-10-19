import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { useAuth } from "@/hooks/useAuth";
import { GitHubIcon } from "@/components/GitHubIcon";

export function LoginDialog({ onClose }: { onClose: () => void }) {
  const { signInWithGitHub, signInWithPassword, signUp, resetPassword, verifyResetCode } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState("");
  // Reset flow: set once the email is sent; shows the one-time-code input.
  const [resetSent, setResetSent] = useState(false);
  const [resetCode, setResetCode] = useState("");

  const submit = async () => {
    setError("");
    setInfo("");
    setLoading(true);
    try {
      if (mode === "signup") {
        await signUp(email, password);
        setInfo("Account created. Check your email for a confirmation link, then sign in.");
        setMode("signin");
      } else if (mode === "reset") {
        if (resetSent) {
          // Verifying the emailed code starts the recovery session; the global
          // "set a new password" dialog takes over from here.
          await verifyResetCode(email, resetCode.trim());
          onClose();
        } else {
          await resetPassword(email);
          setResetSent(true);
          setInfo("If an account exists for that address, an email is on its way. Follow its link, or enter the code from it below.");
        }
      } else {
        await signInWithPassword(email, password);
        onClose();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const github = async () => {
    setError("");
    try {
      // No explicit target: the provider defaults to the current page with the
      // hash stripped (a stray `#` corrupts GoTrue's token fragment).
      await signInWithGitHub();
      // Redirects away; nothing more to do here.
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "GitHub sign-in failed");
    }
  };

  return (
    <DialogOverlay onClose={onClose} maxWidth="max-w-xs">
      <div className="space-y-1 text-center">
        <h2 className="text-lg font-semibold">
          {mode === "signup" ? "Create account" : mode === "reset" ? "Reset password" : "Log in"}
        </h2>
        <p className="text-xs text-muted-foreground">
          {mode === "reset"
            ? "Enter your email and we'll send you a reset link and code."
            : "Log in to share presentations online across devices."}
        </p>
      </div>

      {mode !== "reset" && (
        <>
          <Button variant="outline" className="w-full" onClick={github}>
            <GitHubIcon />
            Continue with GitHub
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">or</span>
            </div>
          </div>
        </>
      )}

      <div className="space-y-2">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          autoComplete="email"
        />
        {mode !== "reset" && (
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && email && password) submit(); }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        )}
        {mode === "reset" && resetSent && (
          <input
            type="text"
            inputMode="numeric"
            placeholder="Code from the email"
            value={resetCode}
            onChange={(e) => setResetCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && resetCode) submit(); }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-center font-mono tracking-widest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            autoComplete="one-time-code"
            autoFocus
          />
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {info && <p className="text-sm text-muted-foreground">{info}</p>}
        <Button
          className="w-full"
          disabled={!email || (mode !== "reset" && !password) || (mode === "reset" && resetSent && !resetCode) || loading}
          onClick={submit}
        >
          {loading
            ? "Please wait…"
            : mode === "signup"
              ? "Sign up"
              : mode === "reset"
                ? resetSent ? "Verify code" : "Send reset email"
                : "Log in"}
        </Button>
      </div>

      {mode === "signin" && (
        <button
          type="button"
          onClick={() => { setMode("reset"); setResetSent(false); setResetCode(""); setError(""); setInfo(""); }}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4 mx-auto block"
        >
          Forgot password?
        </button>
      )}
      <button
        type="button"
        onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setResetSent(false); setResetCode(""); setError(""); setInfo(""); }}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4 mx-auto block"
      >
        {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Log in"}
      </button>
    </DialogOverlay>
  );
}
