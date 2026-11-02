import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { SessionQRCode } from "@/components/SessionQRCode";
import { CopyField } from "@/components/CopyField";
import { LanAddressField } from "@/components/LanAddressField";
import type { LanStatus } from "@/lib/joinUrl";
import { ShareEmptyState } from "@/components/ShareEmptyState";
import { authEnabled } from "@/lib/authMode";

// Share overlay shared by desktop and mobile. For a local (not-yet-synced)
// session it prompts the presenter to sync online; otherwise it shows the QR
// code and the viewer/controller links.
export function ShareDialog({
  id,
  viewerUrl,
  controllerUrl,
  lanAddress,
  onLanAddressChange,
  lanStatus,
  lanOrigin,
  lanShareable,
  local,
  loggedIn,
  syncing,
  syncError,
  capReached,
  onLogin,
  onSync,
  onClose,
  maxWidth = "max-w-[50%]",
}: {
  id: string;
  viewerUrl: string;
  controllerUrl: string;
  lanAddress: string;
  onLanAddressChange: (address: string) => void;
  lanStatus: LanStatus;
  lanOrigin: string;
  lanShareable: boolean;
  local: boolean;
  loggedIn: boolean;
  syncing: boolean;
  syncError: string;
  capReached: boolean;
  onLogin: () => void;
  onSync: () => void;
  onClose: () => void;
  maxWidth?: string;
}) {
  return (
    <DialogOverlay onClose={onClose} maxWidth={maxWidth}>
      {local ? (
        <>
          <p className="text-sm text-muted-foreground text-center">
            {authEnabled
              ? "This presentation is local to this browser. Sync it online to let viewers join from any device."
              : "This presentation is local to this browser. Share it on your network to let other devices here join — open Presio at this machine's LAN IP (not localhost) so the code and QR are reachable."}
          </p>
          <br />
          <br />
          <ShareEmptyState
            id={id}
            loggedIn={loggedIn}
            syncing={syncing}
            syncError={syncError}
            capReached={capReached}
            onLogin={onLogin}
            onSync={onSync}
          />
        </>
      ) : (
        <>
          <SessionQRCode sessionId={id} url={viewerUrl} shareable={lanShareable} />
          {lanShareable && (
            <div className="space-y-2">
              <CopyField label="Viewer link" value={viewerUrl} />
              <CopyField label="Controller link" value={controllerUrl} />
            </div>
          )}
          <LanAddressField
            value={lanAddress}
            onChange={onLanAddressChange}
            status={lanStatus}
            origin={lanOrigin}
            shareable={lanShareable}
          />
        </>
      )}
      <br />
      <br />
      <Button className="w-full" variant="ghost" onClick={onClose}>
        Close
      </Button>
    </DialogOverlay>
  );
}
