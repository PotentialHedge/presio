import type { ReactNode } from "react";
import { Mosaic, MosaicWindow, type MosaicNode } from "react-mosaic-component";
import { createDragDropManager } from "dnd-core";
import { HTML5Backend } from "react-dnd-html5-backend";
import { TouchBackend } from "react-dnd-touch-backend";
import { MultiBackend, PointerTransition, TouchTransition } from "react-dnd-multi-backend";
import { X } from "lucide-react";
import { CARD_LABELS } from "@/lib/controllerLayout";
import "react-mosaic-component/react-mosaic-component.css";
import "@/pages/controllerMosaic.css";

// Mosaic's own drag-and-drop, but a touch (a finger, an Apple Pencil) has to
// travel a little before it picks a card up: a pen's tap always wobbles, and
// with no slop that wobble was a drag, rearranging the cards.
const dragAndDrop = createDragDropManager(MultiBackend, window, {
  backends: [
    { id: "html5", backend: HTML5Backend, transition: PointerTransition },
    { id: "touch", backend: TouchBackend, options: { enableMouseEvents: true, touchSlop: 12 }, preview: true, transition: TouchTransition },
  ],
});

// The header's buttons are never where a drag starts: the drag backends
// listen on the header for these, so they stop here (clicks still arrive).
const keepDragsOut = (el: HTMLElement | null) => {
  if (!el) return;
  const stop = (e: Event) => e.stopPropagation();
  el.addEventListener("touchstart", stop, { passive: true });
  el.addEventListener("mousedown", stop);
};

export interface CardEntry {
  content: ReactNode;
  /** Header title; built-in cards take theirs from CARD_LABELS. */
  title?: string;
  action?: ReactNode;
}

// Desktop body: the draggable/resizable tiling dashboard. Each tile's header is
// our own toolbar (also the drag handle) with the card title, an optional action
// (e.g. the notes text size), and a hide button.
export function ControllerDashboard({
  value,
  onChange,
  cards,
  onHideCard,
}: {
  value: MosaicNode<string> | null;
  onChange: (node: MosaicNode<string> | null) => void;
  cards: Record<string, CardEntry>;
  onHideCard: (key: string) => void;
}) {
  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <Mosaic<string>
        className="controller-mosaic"
        value={value}
        onChange={onChange}
        dragAndDropManager={dragAndDrop}
        renderTile={(key, path) => (
          <MosaicWindow<string>
            path={path}
            title={cards[key].title ?? CARD_LABELS[key]}
            renderToolbar={() => (
              <div className="flex items-center justify-between w-full px-3 py-1.5 cursor-move select-none">
                <span className="text-xs text-muted-foreground font-semibold">{cards[key].title ?? CARD_LABELS[key]}</span>
                <div ref={keepDragsOut} className="flex items-center gap-1">
                  {cards[key].action}
                  <button
                    type="button"
                    onClick={() => onHideCard(key)}
                    title="Hide card"
                    className="inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            )}
          >
            <div className="h-full flex flex-col p-3 pt-1">
              <div className="flex-1 min-h-0">{cards[key].content}</div>
            </div>
          </MosaicWindow>
        )}
        zeroStateView={
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            All cards hidden — enable them in Settings.
          </div>
        }
      />
    </div>
  );
}
