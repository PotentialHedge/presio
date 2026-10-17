// Speaker notes for the current slide, on the presenter's dashboard. Reads
// them out of the PDF and saves edits back into it (deckNotes.ts); Presio
// itself knows nothing about notes.

import { useEffect, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { mount, usePresio } from "../sdk/react";
import { readNotes, writeNotes, type Notes } from "./deckNotes";
import "./notes.css";

const SCALE_MIN = 0.75;
const SCALE_MAX = 2.5;
const SCALE_STEP = 0.125;

function useNotes(): [Notes, (slide: number, text: string) => void] {
  const [notes, setNotes] = useState<Notes>(new Map());
  useEffect(() => {
    let current = true;
    const load = () =>
      readNotes().then(
        (next) => current && setNotes(next),
        () => { /* unreadable deck: keep what we have */ }
      );
    load();
    // A saved edit, a replaced deck or a live reload.
    const off = presio.deck.onChange(load);
    return () => {
      current = false;
      off();
    };
  }, []);
  // Show a saved edit before the re-read of the new deck lands.
  const reflect = (slide: number, text: string) =>
    setNotes((prev) => {
      const next = new Map(prev);
      if (text) next.set(slide, text);
      else next.delete(slide);
      return next;
    });
  return [notes, reflect];
}

function SizeButtons({ scale }: { scale: number }) {
  const set = (next: number) => void presio.settings.set("fontScale", Math.min(SCALE_MAX, Math.max(SCALE_MIN, next)));
  return (
    <div className="size" onClick={(e) => e.stopPropagation()}>
      <button title="Smaller notes text" data-testid="notes-smaller" disabled={scale <= SCALE_MIN} onClick={() => set(scale - SCALE_STEP)}>
        A−
      </button>
      <button title="Larger notes text" data-testid="notes-larger" disabled={scale >= SCALE_MAX} onClick={() => set(scale + SCALE_STEP)}>
        A+
      </button>
    </div>
  );
}

function Panel() {
  const { slide } = usePresio();
  const [notes, reflect] = useNotes();
  const scale = (presio.settings.get("fontScale") as number) ?? 1;
  const fontSize = `${14 * scale}px`;
  const text = notes.get(slide.current) ?? "";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // A new slide means new notes, so an edit in progress no longer applies.
  const [editedSlide, setEditedSlide] = useState(slide.current);
  if (editedSlide !== slide.current) {
    setEditedSlide(slide.current);
    setEditing(false);
    setError("");
  }

  const save = async () => {
    const value = draft.trim();
    setSaving(true);
    setError("");
    try {
      await writeNotes(slide.current, value);
      reflect(slide.current, value);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save notes");
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="notes editing">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add speaker notes (markdown supported)…"
          style={{ fontSize }}
        />
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
          <button className="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="notes"
      title="Click to edit speaker notes"
      onClick={() => {
        setDraft(text);
        setError("");
        setEditing(true);
      }}
    >
      <SizeButtons scale={scale} />
      {text ? (
        <div
          className="prose"
          data-testid="speaker-notes"
          style={{ fontSize }}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(text) as string) }}
        />
      ) : (
        <p className="empty">Click to add speaker notes.</p>
      )}
    </div>
  );
}

mount(<Panel />);
