import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentPrompt } from "@/lib/plugins/agentPrompt";

// The home page's "make it yours" section: one button copies a prompt, and the
// coding agent it's pasted into asks what to build, then builds it as a plugin.
// The ideas behind the button are only there to inspire.

const IDEAS: [idea: string, size: string, faded: boolean][] = [
  ["multiple-choice polls", "text-lg", false],
  ["live captions", "text-sm", true],
  ["a countdown on every screen", "text-base", false],
  ["audience Q&A", "text-xl", false],
  ["emoji reactions", "text-sm", true],
  ["a speaker timer", "text-base", true],
  ["a QR code to join", "text-lg", false],
  ["quiz with a leaderboard", "text-sm", false],
  ["confetti on the last slide", "text-base", true],
  ["a laser pointer from your phone", "text-sm", true],
  ["word clouds from the audience", "text-lg", true],
  ["slide notes on your watch", "text-sm", false],
  ["live translation", "text-base", false],
  ["a progress bar", "text-sm", true],
];

export function CustomizeWithAgent() {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(agentPrompt("")).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {}
    );
  };

  return (
    <div className="text-center">
      <div className="mb-3.5 font-mono text-xs font-semibold uppercase tracking-wide text-(--home2-accent)">
        Make it yours
      </div>
      <h2 className="mb-3 text-xl font-semibold leading-tight tracking-tight md:text-2xl">
        Missing something? Your agent builds it in minutes.
      </h2>
      <p className="mx-auto max-w-[52ch] text-[15px] text-muted-foreground">
        Paste one prompt into Claude Code, Codex or Cursor, say what you want, and it hands you a working plugin.
      </p>

      <div className="relative mx-auto mt-10 max-w-3xl">
        <div
          aria-hidden
          className="flex flex-wrap items-center justify-center gap-x-6 gap-y-4 px-2 py-6 select-none [mask-image:radial-gradient(ellipse_at_center,transparent_18%,black_55%)]"
        >
          {IDEAS.map(([idea, size, faded]) => (
            <span
              key={idea}
              className={`${size} whitespace-nowrap ${faded ? "text-muted-foreground/50" : "text-muted-foreground"}`}
            >
              {idea}
            </span>
          ))}
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <Button size="lg" onClick={copy} className="shadow-lg" data-testid="home-agent-prompt-copy">
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied — paste it into your agent" : "Copy prompt"}
          </Button>
        </div>
      </div>
    </div>
  );
}
