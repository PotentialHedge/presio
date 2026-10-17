import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { ThemeProvider } from "@/lib/theme";
import { AuthProvider } from "@/lib/auth";
import { PasswordRecoveryDialog } from "@/components/PasswordRecoveryDialog";
import { PluginPrompts } from "@/components/plugins/TrustPrompt";
import Home from "@/pages/Home";
import Presentation from "@/pages/Presentation";
import Present from "@/pages/Present";
import Start from "@/pages/Start";
import Share from "@/pages/Share";
import { misplacedUrl, onViewerOrigin } from "@/lib/origins";
import { startRecording } from "@/lib/analytics";

const CheckerPage = lazy(() => import("@/pages/checker/CheckerPage"));

/** Sends a URL on the wrong side of the app/viewer origin split across (see
 *  lib/origins.ts) — on load, and on every in-app navigation after it. */
function OriginGuard({ children }: { children: React.ReactNode }) {
  const { pathname, search } = useLocation();
  const target = misplacedUrl(pathname, search);
  if (target) {
    window.location.replace(target);
    return null;
  }
  return children;
}

/** Starts session recording on any page but a presentation, which decides
 *  for itself once its role settles — viewers are never recorded. The viewer
 *  origin serves nothing else, so it never records at all. */
function SessionRecording() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (!onViewerOrigin && !/^\/s\/[^/]+\/?$/.test(pathname)) startRecording();
  }, [pathname]);
  return null;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <OriginGuard>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/present" element={<Present />} />
              <Route path="/start/:id" element={<Start />} />
              <Route path="/s/:id" element={<Presentation />} />
              <Route path="/s/:id/share" element={<Share />} />
              <Route path="/check" element={<Suspense fallback={null}><CheckerPage /></Suspense>} />
              {/* Anything else is a stale or mistyped URL — send it home rather
                  than render a blank page. Last so it can only ever match what
                  the routes above didn't, and harmless to the paths the server
                  answers itself (/llms.txt, /api.md, …): those never reach the
                  SPA, since the server resolves them before the index.html
                  fallback. `replace` keeps the dead URL out of the history. */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </OriginGuard>
          <SessionRecording />
          <PasswordRecoveryDialog />
          {/* ?plugins= links, Settings' "Add plugin" and plugin updates all
              ask here, on whichever page the presenter is on. */}
          <PluginPrompts />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
