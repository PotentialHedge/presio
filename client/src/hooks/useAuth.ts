import { createContext, useContext } from "react";
import type { Session, User } from "@supabase/supabase-js";

export interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signInWithGitHub: (redirectTo?: string) => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Email a password-reset link that returns the user to the current page. */
  resetPassword: (email: string) => Promise<void>;
  /** Verify the one-time code from the reset email; starts password recovery. */
  verifyResetCode: (email: string, code: string) => Promise<void>;
  /** Set a new password (valid during the recovery session from the email link). */
  updatePassword: (password: string) => Promise<void>;
  /** True while the user arrived via a reset link and must choose a new password. */
  passwordRecovery: boolean;
  clearPasswordRecovery: () => void;
  /** Error from an auth email link (expired/used), parsed from the URL fragment. */
  authLinkError: string | null;
  clearAuthLinkError: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
