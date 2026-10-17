import { useEffect, useState } from "react";
import { useSearchParams, useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { loadExternalPdfMeta, createExternalSession } from "@/lib/externalSession";
import { supabase } from "@/lib/supabaseClient";
import { track } from "@/lib/analytics";

// Deep link: /present?from=<url-to-pdf> creates a shareable session from an
// externally-hosted PDF and drops the visitor straight into the controller.
// Lets a presentation be launched from a single URL with no upload or login.
export default function Present() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const from = searchParams.get("from") || "";
  const [loadError, setLoadError] = useState("");
  // Missing-param is derivable from the URL — no effect/state needed for it.
  const error = from ? loadError : "Missing ?from=<url> parameter.";

  useEffect(() => {
    let cancelled = false;
    if (!from) return;
    (async () => {
      try {
        const meta = await loadExternalPdfMeta(from);
        const { data: sessionData } = await supabase.auth.getSession();
        const id = await createExternalSession(meta, sessionData.session?.access_token);
        track("present-link", { ok: true });
        if (!cancelled) navigate(`/s/${id}?role=controller`, { replace: true });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Failed to start presentation";
        track("present-link", { ok: false, error: message });
        if (!cancelled) setLoadError(message);
      }
    })();
    return () => { cancelled = true; };
  }, [from, navigate]);

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 space-y-4 text-center">
            <p className="text-3xl">😕</p>
            <h2 className="text-lg font-semibold">{error}</h2>
            <Button asChild className="w-full">
              <Link to="/">Back to Home</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-muted-foreground">Starting presentation…</p>
    </div>
  );
}
