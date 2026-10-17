// The prompt that has a coding agent build a plugin: it reads /plugins.md,
// makes the repo, and hands back a ?plugins= link to open. Copied from the
// home page and from Settings → Plugins.

import { appOrigin } from "@/lib/origins";

export function agentPrompt(what: string): string {
  const task = what.trim().replace(/\.$/, "");
  const guide = `Read ${appOrigin}/plugins.md and build me a Presio plugin`;
  return task ? `${guide} that ${task}.` : `${guide}. Ask me what it should do first.`;
}
