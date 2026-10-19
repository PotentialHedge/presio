import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { QRCodeSVG } from "qrcode.react";
import { idbGet } from "@/lib/localStore";
import { isLocalDeckId } from "@/lib/localId";
import { useAuth } from "@/hooks/useAuth";
import { authEnabled } from "@/lib/authMode";
import { useClaim } from "@/hooks/useClaim";
import { LoginDialog } from "@/components/LoginDialog";
import { LanAddressField } from "@/components/LanAddressField";
import { ShareEmptyState } from "@/components/ShareEmptyState";
import { useJoinUrls } from "@/lib/joinUrl";

export default function Share() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const loggedIn = !!user;
  const { syncing, syncError, sync } = useClaim(id!);

  // Starts true for a browser-local id: there is no server row to ask about,
  // so the share screen renders its no-code-yet state immediately — offline
  // included — rather than flashing a code-shaped layout first.
  const [local, setLocal] = useState(() => isLocalDeckId(id!));
  const [loginOpen, setLoginOpen] = useState(false);

  // Share URLs honor a presenter-entered LAN address (lib/joinUrl.ts) so QR
  // codes scanned from other devices resolve when Presio is opened over
  // localhost in a local deployment.
  const {
    address: lanAddress,
    setAddress: setLanAddress,
    status: lanStatus,
    origin: lanOrigin,
    shareable: lanShareable,
    viewerUrl,
    controllerUrl,
  } = useJoinUrls(id!);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // A PDF in IndexedDB means this is a local session on this device.
        const rec = await idbGet(id!);
        if (rec) {
          if (!cancelled) {
            setLocal(true);
            document.title = `${rec.filename} - Share`;
          }
          return;
        }
        // A local id was never registered: nothing to look up, and offline the
        // lookup is a wait with no answer at the end of it.
        if (isLocalDeckId(id!)) return;
        const res = await fetch(`/api/sessions/${id}`);
        if (!res.ok) return;
        const session = await res.json();
        if (!cancelled) {
          setLocal(!!session.local);
          document.title = `${session.filename} - Share`;
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; document.title = "Presio"; };
  }, [id]);

  // Don't auto-open the viewer here — the controller prompts the presenter to
  // open it themselves, which keeps the controller as the active tab.
  const start = (role: "controller" | "viewer") => {
    navigate(`/s/${id}?role=${role}`);
  };

  // Sharing a deck that was never registered mints its code server-side, so
  // the deck moves to a new id — follow it rather than sitting on a URL whose
  // record has just been handed over.
  const syncOnline = async () => {
    const shared = await sync();
    if (!shared) return;
    setLocal(false);
    if (shared !== id) navigate(`/s/${shared}/share`, { replace: true });
  };

  const showOverlay = local;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="pt-6 space-y-6">
          <div className="text-center space-y-4">
            {showOverlay ? (
              <ShareEmptyState
                id={id!}
                loggedIn={loggedIn}
                syncing={syncing}
                syncError={syncError}
                onLogin={() => setLoginOpen(true)}
                onSync={syncOnline}
              />
            ) : (
              <>
                <div className="flex justify-center">
                  <QRCodeSVG value={viewerUrl} size={180} className="rounded" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Session Code</p>
                  <p className="text-5xl font-bold tracking-widest font-mono select-all">
                    {id}
                  </p>
                </div>
              </>
            )}

            <p className="text-sm text-muted-foreground">
              {local
                ? authEnabled
                  ? "This presentation stays in your browser. Viewers can join in another window or tab on this device and browser. Log in and sync to share online."
                  : "This presentation stays in your browser. Share it on your network to let other devices here join — open Presio at this machine's LAN IP (not localhost) so the code and QR are reachable."
                : "Share this code or scan the QR to join as a viewer"}
            </p>
          </div>

          {!local && (
            <div className="space-y-3">
              {/* Loopback links are useless to whoever they're handed to, so
                  they wait until an address other devices can reach is known. */}
              {lanShareable && (
                <>
                  <CopyRow label="Controller link" url={controllerUrl} />
                  <CopyRow label="Viewer link" url={viewerUrl} />
                </>
              )}
              <LanAddressField
                value={lanAddress}
                onChange={setLanAddress}
                status={lanStatus}
                origin={lanOrigin}
                shareable={lanShareable}
              />
            </div>
          )}

          {showOverlay ? (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => start("controller")}
              >
                {loggedIn || !authEnabled ? "Keep it local" : "Continue without login"}
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => start("controller")}>
                Start Presentation
              </Button>
              <Button className="flex-1" variant="outline" onClick={() => start("viewer")}>
                Open as Viewer
              </Button>
            </div>
          )}

          <div className="text-center">
            <Link
              to="/"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
            >
              Back to Home
            </Link>
          </div>
        </CardContent>
      </Card>

      {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
    </div>
  );
}

function CopyRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex gap-2">
        <code className="flex-1 text-xs bg-muted rounded px-3 py-2 overflow-x-auto select-all">
          {url}
        </code>
        <Button
          variant="outline"
          onClick={() => {
            navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
