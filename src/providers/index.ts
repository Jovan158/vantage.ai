// Provider registry. Vantage currently supports Claude Code only, so there is
// one provider: Anthropic.
//
// Everything above this layer (meter, event log, replay, policy, quota) works on
// the normalised TurnContent shape. A provider only has to say which request
// paths carry a turn and how to parse that provider's streaming/JSON responses,
// so supporting another agent later is additive: no core changes. (An OpenAI
// provider for Codex CLI and Aider existed and was removed — see git history.)

import type { TurnContent, TurnExtractor } from "../turn.ts";
import { createTurnExtractor, extractTurnFromJson } from "../turn.ts";

export type ProviderName = "anthropic";

export interface Provider {
  name: ProviderName;
  /** Does this request path carry a model turn worth observing? */
  isObservablePath(path: string): boolean;
  createTurnExtractor(): TurnExtractor;
  extractTurnFromJson(body: string): TurnContent | null;
}

const anthropic: Provider = {
  name: "anthropic",
  isObservablePath: (p) => p.includes("/v1/messages"),
  createTurnExtractor,
  extractTurnFromJson,
};

const PROVIDERS: Record<ProviderName, Provider> = { anthropic };

export function getProvider(name: ProviderName): Provider {
  return PROVIDERS[name];
}
