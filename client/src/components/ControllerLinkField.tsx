import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/CopyField";

/**
 * The controller link on the share surfaces. It only works with the session's
 * passphrase in it (lib/sessionAuth.ts): without one, the device that opens it
 * is let in as a viewer. So until a passphrase exists this offers to make one,
 * rather than handing out a link that quietly opens a second viewer
 * (issue #172).
 */
export function ControllerLinkField({
  url,
  ready,
  busy,
  error,
  onCreate,
}: {
  url: string;
  /** Whether `url` carries the passphrase. */
  ready: boolean;
  busy: boolean;
  error: string;
  onCreate: () => void;
}) {
  if (ready) {
    return (
      <div className="space-y-1">
        <CopyField label="Controller link" value={url} />
        <p className="text-xs text-muted-foreground">
          Opens the presentation with full control. Share it only with co-presenters.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">Controller link</p>
      <p className="text-xs text-muted-foreground">
        To control the presentation from another device, create a controller link. It includes the
        passphrase, so that device doesn't join as a viewer.
      </p>
      <Button size="sm" variant="outline" disabled={busy} onClick={onCreate}>
        {busy ? "Creating…" : "Create controller link"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
