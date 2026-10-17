// Plugins waiting on the presenter: the queue behind the trust prompt
// (components/plugins/TrustPrompt.tsx), one plugin (with its dependencies)
// at a time.
//
// Anything can ask: a ?plugins= link, Settings → Plugins → Add plugin, an
// update that wants more than it had, a dev branch whose new commit does.

import { useSyncExternalStore } from "react";
import type { LoadedPlugin } from "./manifest";
import type { Resolution } from "./resolve";
import { track } from "@/lib/analytics";

/** Why the prompt is up, which sets its wording and buttons. */
export type PromptReason =
  /** A ?plugins= link. */
  | "link"
  /** Settings → Plugins → Add plugin. */
  | "add"
  /** A newer version of an installed plugin that needs approval. */
  | "update"
  /** A dev branch's new commit asks for more than was approved. */
  | "dev";

export type PromptChoice = "once" | "install" | "skip";

export interface PromptOutcome {
  choice: PromptChoice;
  /** The plugin, when it was loaded or installed. */
  key?: string;
  plugin?: LoadedPlugin;
}

export interface PromptRequest {
  id: number;
  /** A plugin source, as given. */
  input: string;
  reason: PromptReason;
  /** Already looked up (updates, dev reloads); else the prompt looks it up. */
  resolution?: Resolution;
  onDone?: (outcome: PromptOutcome) => void;
}

let queue: PromptRequest[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Ask the presenter about a plugin. A second ask for the same plugin and
 *  reason while one waits is dropped. */
export function requestPlugin(input: string, opts: Omit<PromptRequest, "id" | "input"> ) {
  if (queue.some((r) => r.input === input && r.reason === opts.reason)) return;
  queue = [...queue, { id: nextId++, input, ...opts }];
  emit();
}

/** Take the prompt that's done off the queue. */
export function finishPrompt(id: number, outcome: PromptOutcome) {
  const request = queue.find((r) => r.id === id);
  queue = queue.filter((r) => r.id !== id);
  emit();
  if (request) track("plugin-prompt", { reason: request.reason, choice: outcome.choice, source: request.input });
  request?.onDone?.(outcome);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function usePromptQueue(): PromptRequest[] {
  return useSyncExternalStore(subscribe, () => queue);
}
