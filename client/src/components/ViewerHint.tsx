import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";

// A key cap styled for the viewer's dark background.
function HintKey({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center h-6 min-w-6 px-1.5 rounded border border-white/30 bg-white/10 text-xs font-medium">
      {children}
    </kbd>
  );
}

// A transient hint shown at the top of a freshly-spawned viewer window. It fades
// out after 10s, or as soon as the user presses one of the keys it describes.
// Keys mean nothing on a touch screen, so it isn't shown there; and it never
// takes a click meant for the buttons it may overlap on a narrow window.
export function ViewerHint({ canNavigate }: { canNavigate: boolean }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const hide = () => setVisible(false);
    const timer = setTimeout(hide, 10000);
    const keys = ["f", "F", "ArrowLeft", "ArrowRight", " ", "PageUp", "PageDown"];
    const onKey = (e: KeyboardEvent) => {
      if (keys.includes(e.key)) hide();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div
      className={`pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center [@media(hover:none)]:hidden gap-3 rounded-lg bg-black/70 px-4 py-2 text-sm text-white/90 shadow-md transition-opacity duration-500 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <span className="flex items-center gap-1.5">
        Press <HintKey>F</HintKey> for fullscreen
      </span>
      {canNavigate && (
        <>
          <span className="text-white/30">·</span>
          <span className="flex items-center gap-1.5">
            <HintKey>
              <ArrowLeft size={13} />
            </HintKey>
            <HintKey>
              <ArrowRight size={13} />
            </HintKey>
            to change slides
          </span>
        </>
      )}
    </div>
  );
}
