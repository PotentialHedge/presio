import { useState, useEffect } from "react";
import { Download, Menu, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { useIsTouchDevice } from "@/hooks/useIsMobile";
import { useIsStandalone } from "@/hooks/useIsStandalone";
import { lsGetString, lsSetString, STORAGE_KEYS } from "@/lib/storage";
import { track } from "@/lib/analytics";

// Chrome/Edge's beforeinstallprompt event — not part of the DOM lib.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
    appinstalled: Event;
  }
}

function isIOS(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPhone|iPad|iPod/.test(ua) ||
    // iPadOS reports as a Mac (userAgent is desktop) but has touch points.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

// Add-to-home-screen prompt, shown on touch devices while someone is presenting
// (controller mode) rather than on the landing page — that's the moment running
// installed actually matters, and the app already behaves differently there.
// Uses the platform's install flow (beforeinstallprompt -> prompt()) where the
// browser offers it, and falls back to step-by-step instructions where it
// doesn't (iOS Safari). Never shown on desktop, never when the app is already
// running installed, and never more than once per device.
export function InstallPrompt() {
  // Touch-first screen (phone or tablet, any orientation) — width alone would
  // miss an iPad in landscape.
  const isMobile = useIsTouchDevice();
  const standalone = useIsStandalone();
  const [seen, setSeen] = useState(
    () => lsGetString(STORAGE_KEYS.installPromptSeen) === "true"
  );
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // Capture the browser's prompt while the dialog might be open. Never fires on
    // iOS; on Chrome/Android it can arrive a beat after first paint, so keep
    // listening rather than only checking state once.
    const onInstallable = (e: BeforeInstallPromptEvent) => {
      e.preventDefault();
      setDeferred(e);
    };
    // Install completed (via any route): never offer it again.
    const onInstalled = () => {
      lsSetString(STORAGE_KEYS.installPromptSeen, "true");
      setSeen(true);
    };
    window.addEventListener("beforeinstallprompt", onInstallable);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallable);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!isMobile || standalone || seen) return null;

  const dismiss = () => {
    lsSetString(STORAGE_KEYS.installPromptSeen, "true");
    setSeen(true);
  };

  const install = async () => {
    if (!deferred) return; // fallback is instructions-only
    track("install-app");
    await deferred.prompt();
    // Accepted or declined, the browser dialog is the answer — don't re-ask.
    dismiss();
  };

  return (
    <DialogOverlay onClose={dismiss} maxWidth="max-w-xs">
      <div className="flex flex-col items-center gap-3 text-center">
        {deferred ? (
          <>
            <Download className="text-muted-foreground" size={28} />
            <h2 className="text-lg font-semibold">Install Presio</h2>
            <p className="text-sm text-muted-foreground">
              Add Presio to this device for a full-screen, app-like way to
              upload, control and present slides.
            </p>
            <Button className="w-full" onClick={install}>
              Install
            </Button>
          </>
        ) : (
          <>
            <Share className="text-muted-foreground" size={28} />
            <h2 className="text-lg font-semibold">Add Presio to your Home Screen</h2>
            {isIOS() ? (
              <p className="text-sm text-muted-foreground">
                Tap the Share button{" "}
                <Share size={13} className="inline -mx-0.5 text-foreground" />,
                then choose{" "}
                <span className="font-medium text-foreground">
                  "Add to Home Screen"
                </span>{" "}
                to run Presio like an app.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Open your browser's menu{" "}
                <Menu size={13} className="inline -mx-0.5 text-foreground" /> and
                choose{" "}
                <span className="font-medium text-foreground">
                  "Add to Home Screen"
                </span>{" "}
                or "Install app" to run Presio like an app.
              </p>
            )}
            <Button className="w-full" variant="outline" onClick={dismiss}>
              Got it
            </Button>
          </>
        )}
      </div>
    </DialogOverlay>
  );
}
