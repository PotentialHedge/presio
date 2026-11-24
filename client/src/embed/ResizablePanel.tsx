// A panel under the slide whose top edge drags to resize it, like VS Code's
// own panels: dragged below its minimum it shows it'll close, and closes on
// release (keeping its last height for when it's opened again).

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** What stays of the slide above when a panel is made as tall as it goes. */
const SLIDE_MIN = 160;

export function ResizablePanel({
  height,
  min,
  onResize,
  onClose,
  className,
  children,
}: {
  height: number;
  min: number;
  onResize: (height: number) => void;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; height: number; max: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Captured, so the drag keeps going over the plugins' frames.
    e.currentTarget.setPointerCapture(e.pointerId);
    // It can grow by what the slide (the column's flex-1 child) has to spare.
    const column = ref.current?.parentElement;
    const slide = column ? [...column.children].find((c) => c.classList.contains("flex-1")) : null;
    const spare = slide instanceof HTMLElement ? Math.max(0, slide.offsetHeight - SLIDE_MIN) : 0;
    drag.current = { y: e.clientY, height, max: Math.max(min, height + spare) };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const raw = d.height + (d.y - e.clientY);
    setClosing(raw < min);
    onResize(Math.round(Math.min(d.max, Math.max(min, raw))));
  };
  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (closing) {
      setClosing(false);
      // Opened again, it's as it was before this drag.
      onResize(d.height);
      onClose();
    }
  };

  return (
    <div ref={ref} className={cn("relative shrink-0", closing && "opacity-40", className)} style={{ height }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Drag to resize; drag down past the edge to close"
        className="group absolute inset-x-0 -top-1 h-2 z-20 cursor-row-resize touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className={cn(
            "absolute inset-x-0 top-[3px] h-[2px] transition-colors delay-150 group-hover:bg-(--sash)",
            dragging && "bg-(--sash) delay-0"
          )}
        />
      </div>
      {children}
    </div>
  );
}
