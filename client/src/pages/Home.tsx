import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AccountControl } from "@/components/AccountControl";
import { PresioLogo } from "@/components/PresioLogo";
import { GitHubIcon } from "@/components/GitHubIcon";
import { MobileNotice } from "@/components/MobileNotice";
import { CopyAgentPromptLink, CustomizeWithAgent } from "@/components/CustomizeWithAgent";
import { ConfirmReplaceDialog } from "@/components/controller/ConfirmReplaceDialog";
import { ConfirmReuploadDialog } from "@/components/controller/ConfirmReuploadDialog";
import { ConfirmEndDialog } from "@/components/controller/ConfirmEndDialog";
import { DemoReel } from "@/components/home/DemoReel";
import { JoinCodeInput } from "@/components/home/JoinCodeInput";
import { FeaturesSection, HomeFooter, IntegrationsSection } from "@/components/home/MarketingSections";
import { RecentDeckList } from "@/components/home/RecentDeckList";
import { ScrollReveal } from "@/components/home/ScrollReveal";
import { REPO_URL } from "@/components/home/links";
import { idbPut, idbGet, idbDelete } from "@/lib/localStore";
import { isDeckWatchSupported, PDF_PICKER_OPTIONS } from "@/lib/deckWatcher";
import { createLocalDeck, readPdfFile, STORE_FAILED, type ImportedPdf } from "@/lib/deckImport";
import { getSessionAuth, setSessionAuth, endSession } from "@/lib/utils";
import { lsRemove, lsSetString, sessionKey, deckWatchKey } from "@/lib/storage";
import { forgetDeckRetained } from "@/lib/plugins/host";
import { useSetting } from "@/lib/settings";
import { track } from "@/lib/analytics";
import { matchReupload } from "@/lib/reupload";
import { loadExternalPdfMeta, createExternalSession } from "@/lib/externalSession";
import type { RecentDeck } from "@/lib/recentDecks";
import { supabase } from "@/lib/supabaseClient";
import { controllerHeaders } from "@/lib/sessionAuth";
import { useAuth } from "@/hooks/useAuth";
import { useRecentDecks } from "@/hooks/useRecentDecks";

// A dropped file that matched a known presentation and is waiting on the
// update-vs-create prompt. The decoded blob is kept so "Create separate"
// doesn't re-read or re-parse the file. (The ArrayBuffer it came from is not:
// getDocument() has already transferred it to the pdf.js worker by this point,
// leaving it detached.)
interface ReuploadPrompt extends ImportedPdf {
  target: RecentDeck;
  file: File;
  /** Whether the file's bytes were actually compared (local decks only). */
  compared: boolean;
  /** File System Access handle for the drop, when the browser provided one —
   * persisted with the update so the deck stays watchable afterwards. */
  handle?: FileSystemFileHandle;
}

export default function Home() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [pdfUrl, setPdfUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  // "I know how Presio works": drops the headline, the demo reel and the
  // marketing sections, leaving the drop zone centred on an empty page. Read
  // synchronously from storage so a returning user never sees the full page
  // flash past on the way to the stripped one.
  const [minimal, toggleMinimal] = useSetting("home.minimal");
  const [scrolled, setScrolled] = useState(false);

  // Presentations this browser could control, with an in-place "Replace PDF"
  // action so a recompiled deck keeps its code instead of minting a new one.
  const [recents, setRecents] = useRecentDecks(uploading, user?.id);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<RecentDeck | null>(null);
  const [replaceFile, setReplaceFile] = useState<File | null>(null);
  const [replaceHandle, setReplaceHandle] = useState<FileSystemFileHandle | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [reuploadPrompt, setReuploadPrompt] = useState<ReuploadPrompt | null>(null);
  const [closeTarget, setCloseTarget] = useState<RecentDeck | null>(null);
  const [closing, setClosing] = useState(false);
  // Whether a deck created from here should watch its file for recompiles.
  // Only meaningful where the browser can hold a file handle at all.
  const watchSupported = isDeckWatchSupported();
  const [hotReload, setHotReload] = useState(true);

  const pickReplace = useCallback((target: RecentDeck) => {
    setReplaceFile(null);
    setReplaceHandle(null);
    setReplaceTarget(target);
    // Chromium picks via showOpenFilePicker so the replacement keeps a
    // watchable file handle (the plain input can't provide one); other
    // browsers fall back to the input.
    if (isDeckWatchSupported()) {
      window.showOpenFilePicker?.(PDF_PICKER_OPTIONS)
        .then(async ([handle]) => {
          const file = await handle.getFile();
          if (file.type !== "application/pdf") {
            setReplaceTarget(null);
            setError("Please choose a PDF file");
            return;
          }
          setReplaceHandle(handle);
          setReplaceFile(file);
        })
        .catch(() => setReplaceTarget(null)); // cancelled: nothing to confirm
      return;
    }
    replaceInputRef.current?.click();
  }, []);

  // The whole recents row opens its controller. An account-only deck has never
  // been opened on this device, so persist the controller token the server
  // returned first — the socket join and the replace endpoint authorize with it.
  const openRecent = useCallback(
    (r: RecentDeck) => {
      if (r.kind === "account" && r.controllerToken) {
        // Spread what's already stored: setSessionAuth writes the whole record,
        // so assigning a bare { controllerToken } would drop a passphrase.
        setSessionAuth(r.id, { ...getSessionAuth(r.id), controllerToken: r.controllerToken });
      }
      track("open-recent", { kind: r.kind });
      navigate(`/s/${r.id}?role=controller`);
    },
    [navigate]
  );

  // Close (end) a presentation. A local deck's PDF only ever lived in this
  // browser, so ending it means deleting that IndexedDB copy — the same
  // teardown the controller runs in Presentation.tsx. A synced deck is ended
  // for everyone on the server: viewers are disconnected, the stored PDF is
  // dropped and the row is marked expired. Neither is recoverable, hence the
  // confirm dialog.
  const confirmClose = useCallback(async () => {
    if (!closeTarget || closing) return;
    setClosing(true);
    setError("");
    try {
      if (closeTarget.kind === "local") {
        await idbDelete(closeTarget.id);
        // A local session is presented from two windows in the same browser;
        // the viewer has no server to hear from, so tell it directly on the
        // channel Presentation listens on. Same message endPresentation sends.
        try {
          const channel = new BroadcastChannel(`presio-${closeTarget.id}`);
          channel.postMessage({ type: "session_ended" });
          channel.close();
        } catch {
          // No BroadcastChannel (or it's blocked): the deck is gone either way.
        }
      } else {
        const res = await endSession(closeTarget.id, closeTarget.controllerToken);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to close the presentation");
        }
      }
      // The stored controller credential is dead weight either way.
      lsRemove(sessionKey(closeTarget.id));
      setRecents((rs) => rs.filter((r) => r.id !== closeTarget.id));
      setCloseTarget(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to close the presentation");
      // Dismiss the dialog too: the error renders on the page behind it, so
      // leaving it up looks like the button simply did nothing.
      setCloseTarget(null);
    } finally {
      setClosing(false);
    }
  }, [closeTarget, closing, setRecents]);

  // Swap a deck's PDF in place under the same code — the body shared by the
  // recents list' Replace button and the re-upload prompt's Update action.
  const replaceDeck = useCallback(
    async (target: RecentDeck, file: File, handle?: FileSystemFileHandle) => {
      const { blob, sha256, filename, totalSlides } = await readPdfFile(file);
      if (target.kind === "local") {
        try {
          // Read the record to carry over what the fresh object doesn't know:
          // the original creation time, and the watchable file handle (kept
          // when the replacement arrived without one, replaced when a new
          // handle was captured — a recompile usually lands on the same path).
          const rec = await idbGet(target.id).catch(() => null);
          await idbPut({
            id: target.id,
            filename,
            totalSlides,
            blob,
            sha256,
            createdAt: rec?.createdAt ?? target.createdAt ?? Date.now(),
            handle: handle ?? rec?.handle,
          });
        } catch {
          throw new Error(STORE_FAILED);
        }
      } else {
        // Synced deck: overwrite its server copy. The controller token this
        // browser holds authorizes the write — for an account deck this device
        // never controlled, fall back to the token /api/sessions/mine returned.
        // A logged-in owner token is attached too when present (the server
        // accepts either).
        const stored = getSessionAuth(target.id);
        if (!stored.controllerToken && target.controllerToken) {
          setSessionAuth(target.id, { ...stored, controllerToken: target.controllerToken });
        }
        const headers = await controllerHeaders(target.id);
        const form = new FormData();
        form.append("pdf", blob, `${filename}.pdf`);
        form.append("filename", filename);
        const res = await fetch(`/api/sessions/${target.id}/pdf`, {
          method: "POST",
          headers,
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to replace the PDF");
        }
      }
      // What plugins kept for the old deck (drawings, keyed by slide number)
      // doesn't belong on the new one.
      forgetDeckRetained(target.id);
      // Keep the in-memory recents row in step with the stored record — the
      // hash must reflect the new bytes for the next re-drop to be matched.
      setRecents((rs) =>
        rs.map((r) => (r.id === target.id ? { ...r, filename, totalSlides, sha256 } : r))
      );
      track("deck-replace", {
        filename,
        sha256,
        size: file.size,
        slides: totalSlides,
        mode: target.kind === "local" ? "local" : "server",
      });
      // A synced replace rewrites the stored object at the same URL, so tell
      // the controller page to fetch past any copy this browser already has —
      // it's the one most likely to be holding the pre-replace deck. Viewers
      // in the room get there by their own route (the deck_updated broadcast).
      navigate(`/s/${target.id}?role=controller`, { state: { deckReplaced: Date.now() } });
    },
    [navigate, setRecents]
  );

  const confirmReplace = useCallback(async () => {
    if (!replaceTarget || !replaceFile || replacing) return;
    setReplacing(true);
    setError("");
    try {
      await replaceDeck(replaceTarget, replaceFile, replaceHandle ?? undefined);
      setReplaceTarget(null);
      setReplaceFile(null);
      setReplaceHandle(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to replace the PDF");
    } finally {
      setReplacing(false);
    }
  }, [replaceTarget, replaceFile, replaceHandle, replacing, replaceDeck]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The plain create path: store the deck locally under an id minted here, and
  // open share. Nothing on this path touches the network — the deck's bytes,
  // its id and everything keyed by it are local to this browser, so a PDF can
  // be imported and presented with no connection at all. The join code (and the
  // `sessions` row behind it) is created later, server-side, if and when the
  // presenter shares the deck.
  const createDeck = useCallback(
    async (p: ImportedPdf & { file: File; handle?: FileSystemFileHandle }) => {
      const id = await createLocalDeck(p, { handle: p.handle });
      // Remember how this deck should treat recompiles. The handle is stored
      // either way, so the controller's live-reload control can turn watching
      // on later without asking for the file again.
      lsSetString(deckWatchKey(id), p.handle && hotReload ? "prompt" : "off");
      // Counted only once the deck is durably stored; the analytics sink
      // timestamps each event, so two uploads of the same filename can be
      // compared by hash to spot recompiled vs. re-uploaded decks.
      track("upload", { filename: p.filename, sha256: p.sha256, size: p.file.size, slides: p.totalSlides });
      navigate(`/s/${id}/share`);
    },
    [navigate, hotReload]
  );

  const upload = useCallback(
    async (file: File, handle?: FileSystemFileHandle) => {
      setError("");
      setUploading(true);
      setProgress(0);
      try {
        const pdf = await readPdfFile(file);
        setProgress(100);
        const { blob, sha256, filename, totalSlides } = pdf;

        // Fork on a re-upload before anything is created: the recents list is
        // already in memory, so the comparison costs no network round-trip and
        // a no-match drop adds no prompt or delay.
        const match = await matchReupload(filename, sha256, recents);
        if (match?.identical) {
          // Byte-identical re-drop — the person most likely lost their link
          // rather than changed their deck. Reopen the existing presentation
          // and create nothing.
          navigate(`/s/${match.target.id}?role=controller`);
          return;
        }
        if (match) {
          // Same name, different (or unverifiable) bytes: offer update vs.
          // create, defaulting to update, before anything exists server-side
          // or in IndexedDB.
          setReuploadPrompt({
            target: match.target,
            file,
            blob,
            sha256,
            filename,
            totalSlides,
            compared: match.compared,
            handle,
          });
          return;
        }
        await createDeck({ ...pdf, file, handle });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Upload failed";
        track("upload-error", { error: message });
        setError(message);
      } finally {
        setUploading(false);
      }
    },
    [navigate, recents, createDeck]
  );

  // Update branch of the re-upload prompt: swap the dropped file into the
  // matched presentation via the same code path as the recents Replace button.
  const confirmReuploadUpdate = useCallback(async () => {
    if (!reuploadPrompt || replacing) return;
    setReplacing(true);
    setError("");
    try {
      await replaceDeck(reuploadPrompt.target, reuploadPrompt.file, reuploadPrompt.handle);
      setReuploadPrompt(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to replace the PDF");
    } finally {
      setReplacing(false);
    }
  }, [reuploadPrompt, replacing, replaceDeck]);

  // Create branch of the re-upload prompt: continue down the plain create
  // path, reusing the already-decoded bytes.
  const confirmReuploadCreate = useCallback(async () => {
    if (!reuploadPrompt || uploading) return;
    setUploading(true);
    setError("");
    try {
      await createDeck(reuploadPrompt);
      setReuploadPrompt(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }, [reuploadPrompt, uploading, createDeck]);

  const submitUrl = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!pdfUrl.trim() || urlBusy) return;
      setError("");
      setUrlBusy(true);
      try {
        const meta = await loadExternalPdfMeta(pdfUrl);
        const { data: sessionData } = await supabase.auth.getSession();
        const id = await createExternalSession(meta, sessionData.session?.access_token);
        track("open-url", { ok: true });
        navigate(`/s/${id}/share`);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Failed to create session";
        track("open-url", { ok: false, error: message });
        setError(message);
      } finally {
        setUrlBusy(false);
      }
    },
    [pdfUrl, urlBusy, navigate]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file?.type !== "application/pdf") {
        setError("Please drop a PDF file");
        return;
      }
      // Capture a File System Access handle synchronously, before the event
      // object goes away, so the deck can be watched later. Falls back to the
      // plain File — no handle, no watching, everything else unchanged. Only
      // trusted for a single-file drop: with several items, items[0] might
      // not be the file the bytes came from.
      const items = e.dataTransfer.items;
      const item = items.length === 1 ? items[0] : undefined;
      const getHandle = item?.getAsFileSystemHandle?.bind(item);
      if (getHandle) {
        getHandle()
          .then((h) =>
            upload(file, h?.kind === "file" ? (h as FileSystemFileHandle) : undefined)
          )
          .catch(() => upload(file));
      } else {
        upload(file);
      }
    },
    [upload]
  );

  // Click-to-browse. Chromium opens the File System Access picker so the
  // picked deck carries a watchable handle; other browsers use the plain
  // file input and behave exactly as before.
  const openFilePicker = useCallback(() => {
    if (isDeckWatchSupported()) {
      window.showOpenFilePicker?.(PDF_PICKER_OPTIONS)
        .then(async ([handle]) => {
          const file = await handle.getFile();
          // The picker's filter is a hint, not a guarantee — check the same way
          // the drop path does rather than failing deep inside pdf.js.
          if (file.type !== "application/pdf") {
            setError("Please choose a PDF file");
            return;
          }
          upload(file, handle);
        })
        .catch(() => { /* cancelled */ });
      return;
    }
    document.getElementById("home2-file-input")?.click();
  }, [upload]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDragging(true);
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDragging(false);
  }, []);

  const onFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) upload(file);
    },
    [upload]
  );

  return (
    <div
      className="home2 min-h-screen bg-background text-foreground"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* env(safe-area-inset-top) is 0 in browser tabs; in the installed app
          it drops the nav below the status bar. */}
      <nav
        className={`sticky top-0 z-40 flex items-center justify-between gap-4 px-4 pt-[calc(env(safe-area-inset-top)+1rem)] pb-4 backdrop-blur transition-colors sm:px-6 ${scrolled ? "border-b bg-background/90" : "border-b border-transparent bg-background/70"
          }`}
      >
        <div className="flex shrink-0 items-center gap-2">
          <PresioLogo className="h-5 w-auto text-foreground" />
          <span className="font-mono text-base font-semibold tracking-tight">Presio</span>
        </div>
        <div className="flex min-w-0 items-center gap-3 sm:gap-5">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="Presio on GitHub"
            aria-label="Presio on GitHub"
            className="hidden text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
          >
            <GitHubIcon />
          </a>
          <AccountControl />
          <ThemeToggle />
        </div>
      </nav>

      <main>
      {/* ---------------------------------------------------------------- hero */}
      <section
        className={
          minimal
            // Nothing follows the panel, so it centres in what's left of the
            // viewport under the nav instead of sitting under a tall hero.
            ? "relative flex min-h-[calc(100svh-9rem)] items-center px-6 py-10"
            : "relative px-6 pb-24 pt-16"
        }
      >
        <div
          className={
            minimal
              ? "mx-auto w-full max-w-[530px]"
              : "mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 md:grid-cols-[0.92fr_1.08fr] md:gap-20 xl:grid-cols-[1fr_1.05fr]"
          }
        >
          <div>
            {!minimal && (
            <div className='max-w-xl'>
              <h1 className="mb-8 font-mono text-4xl font-semibold leading-[1.06] tracking-tight md:text-5xl">
                Better PDF presentations.
                {/* Turn a PDF into a{" "}
              <span className="text-[var(--home2-accent)]">live</span> presentation. */}
              </h1>
              {/* <p className="mb-8 max-w-[46ch] text-base text-muted-foreground md:text-[17px]">
              Drop a deck and get a controller with notes and a viewer that mirrors it in real
              time — on this laptop, or on every screen in the room.
            </p> */}
            </div>
            )}

            {/* The drop target grows with the viewport but stays in a readable
                band: min() so the floor can never exceed the column it sits in
                (below md that column is narrower than the floor itself). In
                minimal mode it is the whole page, so it stays centred. */}
            <div
              className={`mx-auto w-full min-w-[min(100%,320px)] max-w-[420px] py-6 lg:max-w-[480px] xl:max-w-[530px] ${minimal ? "" : "md:mx-0"}`}
            >
              {/* Live reload needs the File System Access API, which only
                  Chromium ships. Worth telling everyone else it exists —
                  it's the difference between one drop and thirty. Minimal mode
                  is for people who already know, so it goes with the rest. */}
              {!watchSupported && !minimal && (
                <p className="mb-3 text-sm text-muted-foreground">
                  Writing your talk? Use Chrome to enable live hot reload when the slides
                  change on disk.
                </p>
              )}
              <div
                className={`cursor-pointer rounded-xl border-2 border-dashed px-9 py-14 text-center transition-colors ${dragging
                  ? "border-(--home2-accent) bg-(--home2-accent-soft)"
                  : "border-muted-foreground/25 hover:border-muted-foreground/50"
                  }`}
                onClick={openFilePicker}
              >
                {uploading ? (
                  <div className="mx-auto w-full max-w-xs space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {progress < 100 ? `Uploading… ${progress}%` : "Processing…"}
                    </p>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-(--home2-accent) transition-[width] duration-200"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="mx-auto mb-3 h-8 w-8 text-muted-foreground/70"
                    >
                      <path d="M12 15V4M12 4l-4 4M12 4l4 4" />
                      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                    </svg>
                    <p className="text-sm text-muted-foreground">Drop a PDF here or click to browse</p>
                    <p className="mt-1 text-xs text-muted-foreground">stays in this browser by default</p>
                  </>
                )}
                <input
                  id="home2-file-input"
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onChange={onFileSelect}
                />
              </div>

              {/* Outside the drop zone: a click in here must not open the
                  file picker. */}
              {watchSupported && (
                <label
                  className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground"
                  title="Live reload — watch this file and offer the new slides when you recompile. You're always asked before anything changes on screen; switch it off any time from the controller."
                >
                  <input
                    type="checkbox"
                    checked={hotReload}
                    onChange={(e) => setHotReload(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-(--home2-accent)"
                  />
                  <span>
                    <span className="font-medium text-foreground">Hot reload</span> — update
                    presentation if file changes on disk.
                  </span>
                </label>
              )}

              <form onSubmit={submitUrl} className="mt-3.5 flex gap-2">
                <input
                  type="url"
                  inputMode="url"
                  placeholder="…or paste a URL to a PDF"
                  value={pdfUrl}
                  onChange={(e) => setPdfUrl(e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--home2-accent)]"
                />
                {pdfUrl.trim() && (
                  <Button type="submit" variant="outline" disabled={urlBusy}>
                    {urlBusy ? "Loading…" : "Go"}
                  </Button>
                )}
              </form>

              {error && <p className="mt-3 text-center text-sm text-destructive">{error}</p>}

              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">or join existing</span>
                </div>
              </div>

              <JoinCodeInput />

              <RecentDeckList
                recents={recents}
                busy={{ replacing, closing }}
                onOpen={openRecent}
                onReplace={pickReplace}
                onClose={setCloseTarget}
              />

              {/* The escape hatch for returning users, and the only way back:
                  it stays visible in minimal mode so the explainer can be
                  brought back without clearing storage. The label names what
                  the click does, so it flips with the mode. */}
              {/* Minimal mode hides the "make it yours" section, so the
                  plugin prompt gets a quiet entry point of its own here. */}
              <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
                {minimal && <CopyAgentPromptLink />}
                <button
                  type="button"
                  onClick={() => toggleMinimal(!minimal)}
                  className="cursor-pointer rounded-sm text-center text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--home2-accent)]"
                >
                  {minimal ? "How does Presio work?" : "Hide distractions"}
                </button>
              </div>
            </div>
          </div>

          {/* The demo reel from the README. Shipped as H.264 rather than the
              34 MB GIF the README links to: same 27 s recording, ~2.9 MB, and
              it decodes on the GPU instead of the main thread. */}
          {!minimal && <DemoReel />}
        </div>
      </section>

      {!minimal && (
      <>
      {/* ------------------------------------------------------------ plugins */}
      <section id="customize" className="px-6 py-24 md:py-28">
        <ScrollReveal className="mx-auto max-w-6xl">
          <CustomizeWithAgent />
        </ScrollReveal>
      </section>

      <IntegrationsSection />
      <FeaturesSection />
      </>
      )}
      </main>

      <HomeFooter />

      {replaceTarget && replaceFile && (
        <ConfirmReplaceDialog
          onConfirm={confirmReplace}
          onClose={() => { setReplaceTarget(null); setReplaceFile(null); setReplaceHandle(null); }}
        />
      )}

      {reuploadPrompt && (
        <ConfirmReuploadDialog
          filename={reuploadPrompt.filename}
          code={reuploadPrompt.target.id}
          compared={reuploadPrompt.compared}
          onUpdate={confirmReuploadUpdate}
          onCreate={confirmReuploadCreate}
          onClose={() => setReuploadPrompt(null)}
        />
      )}

      {closeTarget && (
        <ConfirmEndDialog
          local={closeTarget.kind === "local"}
          onConfirm={confirmClose}
          onClose={() => setCloseTarget(null)}
        />
      )}

      {/* Hidden picker for the recents list' Replace action. Kept outside the
          list so a cancelled picker simply leaves nothing to confirm. */}
      <input
        ref={replaceInputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        data-testid="recents-replace-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) setReplaceFile(file);
          e.target.value = "";
        }}
      />

      <MobileNotice />
    </div>
  );
}
