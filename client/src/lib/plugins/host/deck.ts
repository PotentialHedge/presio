// presio.deck: reading the deck ("deck" permission), saving an edited one
// ("editDeck"), hearing when it changes, and transforming the PDF this
// device downloads (onExport).

import type { PdfAttachment } from "@/lib/pdf";
import { HostError, primaryFrame, type HostCore, type MethodTable } from "./types";

/** A page's size in PDF points (presio.deck.pages()). */
export interface PageSize {
  width: number;
  height: number;
}

/** Which download a plugin's export handler is transforming. */
export type ExportMode = "everything" | "no-attachments";

/** How the deck changed (presio.deck.onChange): the same pages edited in
 *  place, or a different document. */
export type DeckChange = "edit" | "replace";

/** How long one plugin may take over its part of a download. */
const EXPORT_TIMEOUT_MS = 60_000;

export class Deck {
  private core: HostCore;
  private attachments: () => Promise<PdfAttachment[]> = async () => [];
  private bytes: () => Promise<Uint8Array | null> = async () => null;
  private pages: () => Promise<PageSize[]> = async () => [];
  private save: ((bytes: Uint8Array) => Promise<void>) | null = null;
  private nextChange: DeckChange = "replace";

  constructor(core: HostCore) {
    this.core = core;
  }

  readonly methods: MethodTable = {
    "deck.attachments": {
      permission: "deck",
      handler: async () => {
        try {
          // Copies, so a plugin can't mutate the bytes the app itself renders from.
          const list = await this.attachments();
          return list.map(({ filename, content }) => ({ filename, bytes: content.slice() }));
        } catch {
          throw new HostError("Internal", "Couldn't read the deck's attachments");
        }
      },
    },
    "deck.bytes": {
      permission: "deck",
      handler: async () => {
        let bytes: Uint8Array | null;
        try {
          bytes = await this.bytes();
        } catch {
          throw new HostError("Internal", "Couldn't read the deck");
        }
        if (!bytes) throw new HostError("Unavailable", "The deck hasn't loaded yet");
        return bytes.slice();
      },
    },
    "deck.pages": {
      permission: "deck",
      handler: async () => {
        try {
          return await this.pages();
        } catch {
          throw new HostError("Internal", "Couldn't read the deck's pages");
        }
      },
    },
    "deck.save": {
      permission: "editDeck",
      handler: async (_conn, p) => {
        if (this.core.ctx.role !== "presenter" || !this.save) throw new HostError("Unavailable", "The deck can't be edited from here");
        if (!(p.bytes instanceof Uint8Array)) throw new HostError("InvalidParams", "deck.save takes the PDF as a Uint8Array");
        try {
          await this.save(p.bytes);
        } catch (e) {
          throw new HostError("Internal", e instanceof Error ? e.message : "Couldn't save the deck");
        }
        return null;
      },
    },
    "deck.setExporter": {
      handler: (conn, p) => {
        conn.exporter = p.on === true;
        return null;
      },
    },
  };

  /**
   * The deck plugins with the "deck" permission read: its attachments, its
   * bytes and its page sizes. A new source means a new document, which frames
   * hear about. Returns whether it changed.
   */
  setSource(
    attachments: () => Promise<PdfAttachment[]>,
    bytes: () => Promise<Uint8Array | null>,
    pages: () => Promise<PageSize[]>
  ): boolean {
    const changed = this.bytes !== bytes;
    this.attachments = attachments;
    this.bytes = bytes;
    this.pages = pages;
    if (!changed) return false;
    const kind = this.nextChange;
    this.nextChange = "replace";
    for (const conn of this.core.frames()) this.core.emit(conn, "deck.change", { kind });
    return true;
  }

  /** The current deck's page sizes. */
  pageSizes(): Promise<PageSize[]> {
    return this.pages();
  }

  /** The current source's bytes reader, to tell whether it changed since. */
  get bytesReader() {
    return this.bytes;
  }

  /** The next deck swap is an edit of the same pages (a notes save), not a
   *  different document — plugins keep what they hang off its slides. */
  expectEdit() {
    this.nextChange = "edit";
  }

  /** How an edited deck is saved; null where this device can't. */
  setWriter(save: ((bytes: Uint8Array) => Promise<void>) | null) {
    this.save = save;
  }

  /**
   * Pass a PDF this device is downloading through each running plugin's
   * export handler, in plugin order. A plugin that fails or takes too long is
   * skipped, so one broken plugin never blocks a download.
   */
  async export(bytes: Uint8Array, mode: ExportMode, running: readonly string[]): Promise<Uint8Array> {
    let out = bytes;
    for (const pluginId of running) {
      const conn = primaryFrame(this.core.framesOf(pluginId).filter((c) => c.exporter));
      if (!conn) continue;
      try {
        // A copy: the caller's bytes stay intact whatever the plugin does.
        const result = await this.core.call<unknown>(conn, "deck.export", { bytes: out.slice(), mode }, EXPORT_TIMEOUT_MS);
        if (!(result instanceof Uint8Array)) throw new Error("no PDF returned");
        out = result;
      } catch (e) {
        console.warn(`Plugin "${pluginId}" couldn't transform the download:`, e);
      }
    }
    return out;
  }
}
