import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { useAuth } from "@/hooks/useAuth";
import { GitHubIcon } from "@/components/GitHubIcon";

export function LoginDialog({ onClose }: { onClose: () => void }) {
  const { signInWithGitHub, signInWithPassword, signUp, resendConfirmation, resetPassword, verifyResetCode } = useAuth();
  // "confirm": signed up, waiting on the confirmation email.
  const [mode, setMode] = useState<"signin" | "signup" | "reset" | "confirm">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState("");
  // Seconds until another confirmation email may be requested. GoTrue refuses
  // a resend within a minute of the last send anyway; this says so up front.
  const [resendIn, setResendIn] = useState(0);
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);
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
        // A dedicated step rather than a line of text under the login form:
        // people who never saw the email kept signing up again (one did four
        // times, under three addresses, in nine minutes).
        setMode("confirm");
        setResendIn(60);
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

  const resend = async () => {
    setError("");
    setInfo("");
    try {
      await resendConfirmation(email);
      setResendIn(60);
      setInfo("Sent again.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't resend the email");
    }
  };

  // Logging in before confirming fails with GoTrue's "Email not confirmed".
  const unconfirmed = mode === "signin" && /not confirmed/i.test(error);

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

  if (mode === "confirm") {
    return (
      <DialogOverlay onClose={onClose} maxWidth="max-w-xs">
        <div className="space-y-2 text-center">
          <h2 className="text-lg font-semibold">Check your email</h2>
          <p className="text-sm">
            We sent a confirmation link to <span className="font-medium break-all">{email}</span>. Open it, then log in.
          </p>
          <p className="text-xs text-muted-foreground">
            Nothing after a minute? Look in your spam folder or resend it. If the address above has a typo, sign up
            again with the right one.
          </p>
        </div>
        {error && <p className="text-sm text-destructive text-center">{error}</p>}
        {info && <p className="text-sm text-muted-foreground text-center">{info}</p>}
        <div className="space-y-2">
          <Button className="w-full" onClick={() => { setMode("signin"); setError(""); setInfo(""); }}>
            I've confirmed: log in
          </Button>
          <Button variant="outline" className="w-full" disabled={resendIn > 0} onClick={resend}>
            {resendIn > 0 ? `Resend email (${resendIn}s)` : "Resend email"}
          </Button>
        </div>
        <button
          type="button"
          onClick={() => { setMode("signup"); setEmail(""); setError(""); setInfo(""); }}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4 mx-auto block"
        >
          Use a different email
        </button>
      </DialogOverlay>
    );
  }

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
        {unconfirmed && (
          <Button variant="outline" className="w-full" disabled={resendIn > 0} onClick={resend}>
            {resendIn > 0 ? `Resend confirmation email (${resendIn}s)` : "Resend confirmation email"}
          </Button>
        )}
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
