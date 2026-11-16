import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LoginDialog } from "@/components/LoginDialog";
import { SyncedSlots } from "@/components/SyncedSlots";
import { useAuth } from "@/hooks/useAuth";
import { useClaim } from "@/hooks/useClaim";
import { authEnabled } from "@/lib/authMode";
import { createLocalDeck, readPdfFile } from "@/lib/deckImport";
import { MAX_PDF_BYTES, MAX_PDF_MB } from "@/lib/limits";
import { track } from "@/lib/analytics";

// Shown when a local deck's link is opened somewhere its PDF isn't: another
// browser, another device, a private window. The PDF only ever lived in the
// browser that created it, so nothing here can load it — but the presenter
// usually still has the file. Offer to turn it into a shared (synced)
// presentation from this browser: log in, pick the PDF, and it's uploaded
// under a fresh join code that opens anywhere.
export function LocalDeckElsewhere({ requestedRole }: { requestedRole: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canShare = !authEnabled || !!user;
  const [loginOpen, setLoginOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The deck imported into this browser by a share attempt that then failed,
  // so a retry (e.g. after freeing a slot) uploads it without re-picking.
  const [importedId, setImportedId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const { syncing, syncError, capReached, sync } = useClaim(importedId ?? "");
  const busy = importing || syncing;

  const share = async (deckId: string) => {
    const shared = await sync(undefined, deckId);
    if (shared) {
      track("local-elsewhere-shared", { role: requestedRole });
      navigate(`/s/${shared}/share`, { replace: true });
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    if (file.type !== "application/pdf") {
      setError("Please choose a PDF file");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setError(`This PDF is over the ${MAX_PDF_MB} MB upload limit, so it can't be shared online.`);
      return;
    }
    setImporting(true);
    try {
      const pdf = await readPdfFile(file);
      const id = await createLocalDeck(pdf);
      setImportedId(id);
      await share(id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't read that PDF");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6 space-y-4 text-center">
          <p className="text-3xl">🔒</p>
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">This presentation is in another browser</h2>
            <p className="text-sm text-muted-foreground">
              It was kept local, so its PDF is stored only in the browser it was created in.
            </p>
            <p className="text-sm text-muted-foreground">
              {authEnabled
                ? "Presenting? Log in and choose the PDF again to create a shared presentation you can open from any browser or device."
                : "Presenting? Choose the PDF again to share it on this network."}
            </p>
          </div>

          {canShare ? (
            <>
              <Button className="w-full" disabled={busy} onClick={() => inputRef.current?.click()}>
                {importing ? "Reading PDF…" : syncing ? "Sharing…" : "Choose PDF to share"}
              </Button>
              {importedId && !busy && (syncError || capReached) && (
                <Button className="w-full" variant="outline" onClick={() => void share(importedId)}>
                  Try again
                </Button>
              )}
            </>
          ) : (
            <Button
              className="w-full"
              onClick={() => {
                track("local-elsewhere-login", { role: requestedRole });
                setLoginOpen(true);
              }}
            >
              Log in to share
            </Button>
          )}
          {(error || syncError) && (
            <p className="text-sm text-destructive">{error || syncError}</p>
          )}
          {capReached && importedId && <SyncedSlots onFreed={() => void share(importedId)} />}
          {importedId && !busy && (
            <Button asChild className="w-full" variant="ghost">
              <Link to={`/s/${importedId}?role=controller`}>Present in this browser only</Link>
            </Button>
          )}

          <p className="text-xs text-muted-foreground">
            Joining as a viewer? Ask the presenter for the join code.
          </p>
          <Button asChild className="w-full" variant="outline">
            <Link to="/">Back to Home</Link>
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </CardContent>
      </Card>
      {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
    </div>
  );
}
