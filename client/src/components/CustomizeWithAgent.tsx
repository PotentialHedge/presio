import { useState } from "react";
import { Check, Copy, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentPrompt } from "@/lib/plugins/agentPrompt";

// The home page's "make it yours" section: say what you want Presio to do,
// copy one prompt, and a coding agent builds it as a plugin.

const IDEAS = [
  "lets viewers answer multiple-choice polls",
  "shows live captions of what I say",
  "puts a countdown on every screen",
  "collects questions from the audience",
];

const STEPS = [
  ["Say what you want", "Or leave it blank, and your agent asks you."],
  ["Paste it into your agent", "Claude Code, Codex, Cursor… It builds the plugin in a GitHub repo of yours."],
  ["Open the link it gives you", "Presio shows what the plugin can do and asks before it runs."],
] as const;

export function CustomizeWithAgent() {
  const [what, setWhat] = useState("");
  const [copied, setCopied] = useState(false);
  const prompt = agentPrompt(what);

  const copy = () => {
    navigator.clipboard.writeText(prompt).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {}
    );
  };

  return (
    <div className="grid grid-cols-1 gap-10 md:grid-cols-[0.9fr_1.1fr] md:gap-16">
      <div>
        <div className="mb-3.5 font-mono text-xs font-semibold uppercase tracking-wide text-(--home2-accent)">
          Make it yours
        </div>
        <h2 className="mb-3 text-xl font-semibold leading-tight tracking-tight md:text-2xl">
          Missing something? Have your agent build it.
        </h2>
        <p className="mb-8 max-w-[52ch] text-[15px] text-muted-foreground">
          Presio takes plugins: buttons, shortcuts, panels for you, and things on every
          viewer's screen or phone. One prompt is all a coding agent needs to write one.
        </p>
        <ol className="space-y-4">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs text-muted-foreground">
                {i + 1}
              </span>
              <div>
                <div className="text-sm font-medium">{title}</div>
                <div className="text-sm text-muted-foreground">{body}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col justify-center gap-3 rounded-2xl border bg-muted/30 p-5 md:p-6" data-testid="home-agent-prompt">
        <label className="text-sm font-medium" htmlFor="home-plugin-idea">
          What should Presio do?
        </label>
        <input
          id="home-plugin-idea"
          value={what}
          onChange={(e) => setWhat(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") copy(); }}
          placeholder={IDEAS[0]}
          className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm outline-none transition-[box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <div className="flex flex-wrap gap-1.5">
          {IDEAS.map((idea) => (
            <button
              key={idea}
              type="button"
              onClick={() => setWhat(idea)}
              className="cursor-pointer rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {idea}
            </button>
          ))}
        </div>
        <p className="mt-2 rounded-lg border bg-background px-3.5 py-3 font-mono text-[13px] leading-relaxed break-words select-all">
          {prompt}
        </p>
        <Button size="lg" onClick={copy} className="w-full" data-testid="home-agent-prompt-copy">
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied — paste it into your agent" : "Copy prompt"}
        </Button>
        <p className="flex gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            Load only plugins you trust: a plugin can act as you on your device.{" "}
            <a href="/plugins.md" className="underline underline-offset-4 hover:text-foreground">
              How plugins work
            </a>
          </span>
        </p>
      </div>
    </div>
  );
}
