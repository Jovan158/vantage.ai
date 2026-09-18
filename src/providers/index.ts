// Provider registry — the seam that makes Vantage genuinely multi-agent.
//
// Everything above this layer (meter, event log, replay, policy, quota) works on
// the normalised TurnContent shape. A provider only has to say which request
// paths carry a turn and how to parse that provider's streaming/JSON responses.
// Adding a provider is therefore additive: no core changes.

import type { TurnContent, TurnExtractor } from "../turn.ts";
import { createTurnExtractor, extractTurnFromJson } from "../turn.ts";
import { createOpenAITurnExtractor, extractOpenAITurnFromJson } from "./openai.ts";

export type ProviderName = "anthropic" | "openai";

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

const openai: Provider = {
  name: "openai",
  isObservablePath: (p) =>
    p.includes("/chat/completions") || p.includes("/v1/responses") || p.includes("/v1/completions"),
  createTurnExtractor: createOpenAITurnExtractor,
  extractTurnFromJson: extractOpenAITurnFromJson,
};

const PROVIDERS: Record<ProviderName, Provider> = { anthropic, openai };

export function getProvider(name: ProviderName): Provider {
  return PROVIDERS[name];
}
