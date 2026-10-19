import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LoginDialog } from "@/components/LoginDialog";
import { authEnabled } from "@/lib/authMode";
import { useAuth } from "@/hooks/useAuth";

/**
 * Shows the current sign-in status and lets the user log in / out.
 * - "compact": a single inline control (for the home page footer).
 * - "section": a titled block with status + action (for the settings panel).
 */
export function AccountControl({ variant = "compact" }: { variant?: "compact" | "section" }) {
  const { user, signOut, loading } = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);

  // No accounts in a local/offline build — nothing to show.
  if (!authEnabled) return null;
  if (loading) return null;

  if (variant === "section") {
    return (
      <>
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground truncate">
              {user ? user.email : "Not signed in"}
            </span>
            {user ? (
              <Button size="sm" variant="outline" onClick={() => signOut()}>
                Sign out
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setLoginOpen(true)}>
                Sign in
              </Button>
            )}
          </div>
        </section>
        {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
      </>
    );
  }

  return (
    <>
      {user ? (
        // min-w-0 lets the address give way on a phone instead of shoving the
        // control off the bar: it truncates to whatever the nav has left.
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 max-w-[110px] truncate text-xs text-muted-foreground sm:max-w-[180px]">
            {user.email}
          </span>
          <Button size="sm" variant="ghost" className="shrink-0" onClick={() => signOut()}>
            Log out
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setLoginOpen(true)}>
          Log in
        </Button>
      )}
      {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
    </>
  );
}
