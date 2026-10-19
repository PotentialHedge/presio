// A session's deck: what a viewer loads (GET /api/sessions/:id), and the
// controller replacing it — new bytes for a hosted deck, or a republish at
// the source of a URL-backed one.

import type express from "express";
import { isValidTotalSlides } from "../../validation.js";
import { fetchRemotePdfMeta } from "../../lib/remotePdf.js";
import { countDeckPages } from "../../lib/pdfDoc.js";
import { announceDeck, clampSlide, replaceHostedPdf } from "../../lib/hostedDeck.js";
import { loadControlledSession } from "../../lib/sessionAccess.js";
import { deckTitle, isPdfUpload, uploadField } from "../../lib/upload.js";
import type { RouteDeps } from "./index.js";

export function registerDeckRoutes(app: express.Express, { supabase, io, socketState }: RouteDeps) {
  // Replace a synced presentation's PDF in place, keeping its id, code,
  // controller token and passphrase. Two callers:
  //
  //   - Notes editing re-uploads the same document with an embedded sidecar
  //     written by the client. No filename field → nothing announced.
  //   - A deck replacement sends `filename`. The row's filename/slide count
  //     follow the new document, the current slide is clamped into range,
  //     what plugins retained for the old deck is dropped (drawings, keyed by
  //     slide number), and everyone in the room gets `deck_updated` so they
  //     reload the new bytes live.
  //
  // Authorized either by the controller token — the same model as ending a
  // session, so an anonymous presenter (and later agents/CLIs) can rewrite
  // the deck they control — or, in hosted mode, by the logged-in owner.
  app.post("/api/sessions/:id/pdf", uploadField("pdf"), async (req, res) => {
    const file = req.file;
    if (!isPdfUpload(file)) {
      res.status(400).json({ error: "A PDF file is required" });
      return;
    }

    const row = await loadControlledSession(
      supabase, req, res,
      "id, local, pdf_path, pdf_url, user_id, controller_token, filename, current_slide",
      { owner: true, activeOnly: false },
    );
    if (!row) return;
    if (row.local || !row.pdf_path) {
      res.status(400).json({ error: "This presentation's PDF is not hosted on the server" });
      return;
    }

    const pages = await countDeckPages(file.buffer);
    if (!pages.ok) {
      res.status(pages.status).json({ error: pages.error });
      return;
    }
    const { totalSlides } = pages;
    const filename = deckTitle(typeof req.body.filename === "string" ? req.body.filename : "");

    const result = await replaceHostedPdf(supabase, row, { buffer: file.buffer, totalSlides, filename });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    // A real replacement announces itself; a notes re-save (no filename)
    // stays silent so viewers aren't forced to re-download identical slides.
    if (filename) announceDeck({ io, socketState }, String(req.params.id), { filename, totalSlides });

    res.json({ ok: true, totalSlides, filename: filename || row.filename });
  });

  // GET /api/sessions/:id/remote-version — cheap republish detection for a
  // URL-backed deck. Answers with the remote PDF's validator tuple (ETag /
  // Last-Modified / Content-Length, as available) so the controller can tell,
  // without downloading anything, whether the file at `pdf_url` has changed
  // since the previous poll. Authorized like the /pdf route (controller token
  // or the logged-in owner): the values themselves are opaque strings, but
  // there is no reason to let arbitrary visitors probe them.
  //
  //   - 404 when the session is unknown/expired or not URL-backed (local and
  //     server-hosted decks have no pdf_url) — the client reads this as
  //     "nothing to watch" and stops polling.
  //   - 502 when the remote host is unreachable or errors — the client backs
  //     off and keeps today's behaviour; nothing surfaces to the presenter.
  app.get("/api/sessions/:id/remote-version", async (req, res) => {
    const row = await loadControlledSession(supabase, req, res, "id, local, pdf_url, user_id, controller_token", { owner: true });
    if (!row) return;
    if (row.local || !row.pdf_url) {
      res.status(404).json({ error: "This presentation is not backed by an external URL" });
      return;
    }

    const meta = await fetchRemotePdfMeta(row.pdf_url);
    if (!meta) {
      res.status(502).json({ error: "The remote host could not be reached" });
      return;
    }
    res.json(meta);
  });

  // POST /api/sessions/:id/deck-refreshed — the controller noticed (via
  // remote-version polling) that a URL-backed deck was republished at its
  // source and the presenter accepted the new version. Unlike /pdf there are
  // no bytes to store — pdf_url decks keep no server copy — so this only
  // records the new page count, clamps the current slide into range, drops
  // what plugins retained for the old deck (drawings, keyed by slide number)
  // and announces the swap to the room; every client re-fetches the URL
  // itself. The filename is unchanged: a republish replaces the content, not
  // the presentation's title.
  //
  // Unlike /pdf, the page count is asserted by the client rather than parsed
  // here — there are no bytes on this side to count. That is safe because only
  // the controller can call this, and because isValidTotalSlides bounds the
  // value: total_slides gates slide numbers, so an unbounded one would be a
  // lever, but a wrong-but-bounded one only mis-clamps the presenter's own deck
  // until the next real update.
  app.post("/api/sessions/:id/deck-refreshed", async (req, res) => {
    const totalSlides = parseInt(req.body.total_slides, 10);
    if (!isValidTotalSlides(totalSlides)) {
      res.status(400).json({ error: "A valid total_slides is required" });
      return;
    }

    const row = await loadControlledSession(
      supabase, req, res,
      "id, local, pdf_url, user_id, controller_token, filename, current_slide",
      { owner: true },
    );
    if (!row) return;
    if (row.local || !row.pdf_url) {
      res.status(400).json({ error: "This presentation is not backed by an external URL" });
      return;
    }

    const { error: updateError } = await supabase
      .from("sessions")
      .update({ total_slides: totalSlides, current_slide: clampSlide(row.current_slide, totalSlides) })
      .eq("id", row.id);
    if (updateError) {
      res.status(500).json({ error: "Failed to update session" });
      return;
    }

    announceDeck({ io, socketState }, String(req.params.id), { filename: row.filename, totalSlides });
    res.json({ ok: true, totalSlides, filename: row.filename });
  });

  app.get("/api/sessions/:id", async (req, res) => {
    const { data, error } = await supabase
      .from("sessions")
      .select("id, pdf_path, pdf_url, filename, total_slides, current_slide, local")
      .eq("id", req.params.id)
      .neq("status", "expired")
      .single();

    if (error || !data) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // External sessions store the URL directly; Supabase-hosted ones derive a
    // public URL from the object path. Local sessions (including staged handoffs)
    // must never expose pdfUrl — the PDF only belongs in the presenter's browser.
    const pdfUrl = data.local
      ? ""
      : data.pdf_url
        ? data.pdf_url
        : data.pdf_path
          ? supabase.storage.from("presentations").getPublicUrl(data.pdf_path).data.publicUrl
          : "";

    // Return only fields the client needs; never leak controller_token,
    // passphrase, owner user_id, or internal timestamps.
    res.json({
      id: data.id,
      filename: data.filename,
      total_slides: data.total_slides,
      current_slide: data.current_slide,
      local: data.local,
      pdfUrl,
      // Whether pdfUrl points at someone else's host rather than our storage.
      // The client needs this to re-fetch a changed deck correctly: our own
      // object URLs take a cache-busting query parameter, but an external one
      // may be presigned, where an extra parameter invalidates the signature.
      external: !!data.pdf_url,
    });
  });
}
