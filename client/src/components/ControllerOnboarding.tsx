import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Highlighter, Laptop, MonitorPlay, PenLine, Share2, Target, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { markControllerOnboarded } from "@/lib/onboarding";
import { track } from "@/lib/analytics";

// A small reusable key cap, matching the kbd styling used elsewhere.
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center h-8 min-w-8 px-2 rounded-md border border-border bg-muted text-sm font-medium text-muted-foreground shadow-sm">
      {children}
    </kbd>
  );
}

interface Step {
  title: string;
  body: React.ReactNode;
}

function buildSteps(onOpenViewer: () => void): Step[] {
  return [
    {
      title: "Move through your slides",
      body: (
        <div className="space-y-4 text-sm text-muted-foreground">
          <p>Use your keyboard to move back and forth between slides.</p>
          <div className="flex items-center justify-center gap-6">
            <div className="flex flex-col items-center gap-1">
              <Key>
                <ArrowLeft size={15} />
              </Key>
              <span className="text-xs">Previous</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Key>
                <ArrowRight size={15} />
              </Key>
              <span className="text-xs">Next</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Key>Space</Key>
              <span className="text-xs">Next</span>
            </div>
          </div>
        </div>
      ),
    },
    {
      title: "Open the viewer window",
      body: (
        <div className="space-y-4 text-sm text-muted-foreground">
          <p>
            Your audience sees the slides in a separate viewer window, while you
            keep your notes and controls here. Open it now:
          </p>
          <div className="flex justify-center pt-2">
            {/* Stop propagation so the card's click-to-advance doesn't fire too. */}
            <Button onClick={(e) => { e.stopPropagation(); onOpenViewer(); }}>Open Viewer</Button>
          </div>
          <p className="text-center text-xs">
            You can always open it later from the menu bar at the top.
          </p>
        </div>
      ),
    },
    {
      title: "Drag it to another screen",
      body: (
        <div className="space-y-4 text-sm text-muted-foreground">
          <p>
            Move the viewer window onto your projector or second display so your
            audience sees only the slides.
          </p>
          {/* Placeholder two-screen diagram. */}
          <div className="flex items-center justify-center gap-6 py-2">
            <div className="flex flex-col items-center gap-1">
              <Laptop size={48} className="text-foreground" strokeWidth={1.25} />
              <span className="text-xs">Controller (you)</span>
            </div>
            <ArrowRight size={20} className="text-muted-foreground" />
            <div className="flex flex-col items-center gap-1">
              <MonitorPlay size={48} className="text-foreground" strokeWidth={1.25} />
              <span className="text-xs">Viewer (audience)</span>
            </div>
          </div>
        </div>
      ),
    },
    {
      title: "Share with your audience",
      body: (
        <div className="space-y-4 text-sm text-muted-foreground">
          <p>
            Anyone can follow along on their own device. Use the
            <Share2 size={14} className="inline mx-1 -mt-0.5" />
            Share button to show a QR code and join link, or sync online so
            viewers can join from anywhere.
          </p>
          {/* Placeholder for richer sharing illustration. */}
          <div className="flex items-center justify-center py-2">
            <div className="size-24 rounded-md border border-dashed border-border flex items-center justify-center text-xs text-muted-foreground">
              QR / link
            </div>
          </div>
        </div>
      ),
    },
    {
      title: "Draw on your slides",
      body: (
        <div className="space-y-4 text-sm text-muted-foreground">
          <p>
            Click the
            <PenLine size={14} className="inline mx-1 -mt-0.5" />
            pen in the current slide's header to open the drawing tools.
            Everything you draw appears live on every viewer.
          </p>
          <div className="flex items-center justify-center gap-6 py-2">
            <div className="flex flex-col items-center gap-1">
              <Target size={32} className="text-foreground" strokeWidth={1.5} />
              <span className="text-xs">Laser pointer</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <PenLine size={32} className="text-foreground" strokeWidth={1.5} />
              <span className="text-xs">Pen</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Highlighter size={32} className="text-foreground" strokeWidth={1.5} />
              <span className="text-xs">Highlighter</span>
            </div>
          </div>
          <p className="text-center text-xs">
            Save your drawings to a file, or load them back, from the pen's
            options in the same palette.
          </p>
        </div>
      ),
    },
  ];
}

export function ControllerOnboarding({
  onClose,
  onOpenViewer,
}: {
  onClose: () => void;
  onOpenViewer: () => void;
}) {
  const [step, setStep] = useState(0);

  const finish = () => {
    track("onboarding", { completed: step >= lastStep, step });
    markControllerOnboarded();
    onClose();
  };

  const next = () => {
    if (step >= lastStep) finish();
    else setStep(step + 1);
  };

  // Opening the viewer is the goal of that step, so advance once it's done.
  const handleOpenViewer = () => {
    onOpenViewer();
    next();
  };

  const steps = buildSteps(handleOpenViewer);
  const lastStep = steps.length - 1;

  const prev = () => setStep((s) => Math.max(0, s - 1));

  // Drive the tutorial with the keyboard. Listen in the capture phase and stop
  // propagation so Space/arrows advance the tutorial instead of the slides.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        prev();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const current = steps[step];

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      {/* Clicking the card advances, like Space; interactive controls stop propagation. */}
      <Card className="relative w-full max-w-xl min-h-[60vh] flex flex-col cursor-pointer" onClick={next}>
        <button
          type="button"
          aria-label="Close tutorial"
          onClick={(e) => { e.stopPropagation(); finish(); }}
          className="absolute top-3 right-3 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <X size={16} />
        </button>
        <CardContent className="pt-6 flex flex-col flex-1 gap-5">
          <h2 className="text-lg font-semibold">{current.title}</h2>

          <div className="flex-1 flex flex-col justify-center px-6">{current.body}</div>

          {/* Step indicator dots */}
          <div className="flex justify-center gap-1.5">
            {steps.map((_, i) => (
              <span
                key={i}
                className={`size-1.5 rounded-full transition-colors ${i === step ? "bg-primary" : "bg-muted-foreground/30"
                  }`}
              />
            ))}
          </div>

          <div className="flex items-center justify-between gap-2">
            {step > 0 ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); prev(); }}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4"
              >
                Back
              </button>
            ) : (
              <span />
            )}
            <p className="text-xs text-muted-foreground">
              Press <span className="font-medium text-foreground mx-2"><Key>Space</Key></span> to continue
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
