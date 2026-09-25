// The API formats Vantage reads, told apart by the request path. Everything
// above this layer (meter, event log, replay, policy, quota) works on the
// same TurnContent, whichever agent and provider it came from.

import {
  createTurnExtractor,
  extractTurnFromJson,
  requestInfoFrom,
  type RequestInfo,
  type TurnContent,
  type TurnExtractor,
} from "../turn.ts";
import {
  chatParts,
  chatTurnFromJson,
  createChatExtractor,
  createResponsesExtractor,
  responsesParts,
  responsesRequestInfo,
  responsesTurnFromJson,
} from "./openai.ts";
import { createGeminiExtractor, geminiParts, geminiRequestInfo, geminiTurnFromJson } from "./gemini.ts";
import { anthropicParts, type ConversationPart } from "./parts.ts";

export type FormatName = "anthropic" | "openai-responses" | "openai-chat" | "gemini";

export interface Format {
  name: FormatName;
  createTurnExtractor(path: string): TurnExtractor;
  extractTurnFromJson(body: string, path: string): TurnContent | null;
  requestInfo(body: unknown): RequestInfo;
  /** The conversation in a request, for the secret scan. */
  parts(body: unknown, agent: string): ConversationPart[];
}

const anthropic: Format = {
  name: "anthropic",
  createTurnExtractor: () => createTurnExtractor(),
  extractTurnFromJson: (body) => extractTurnFromJson(body),
  requestInfo: requestInfoFrom,
  parts: anthropicParts,
};

const responses: Format = {
  name: "openai-responses",
  createTurnExtractor: () => createResponsesExtractor(),
  extractTurnFromJson: (body) => responsesTurnFromJson(body),
  requestInfo: responsesRequestInfo,
  parts: responsesParts,
};

const chat: Format = {
  name: "openai-chat",
  createTurnExtractor: () => createChatExtractor(),
  extractTurnFromJson: (body) => chatTurnFromJson(body),
  // Chat messages have the Messages API's role/content shape.
  requestInfo: requestInfoFrom,
  parts: chatParts,
};

const gemini: Format = {
  name: "gemini",
  createTurnExtractor: (path) => createGeminiExtractor(path),
  extractTurnFromJson: (body, path) => geminiTurnFromJson(body, path),
  requestInfo: geminiRequestInfo,
  parts: geminiParts,
};

export const FORMATS: Record<FormatName, Format> = {
  anthropic,
  "openai-responses": responses,
  "openai-chat": chat,
  gemini,
};

// The format of a request that carries a model turn, or null for everything
// else an agent sends (model lists, token counts, telemetry, …).
export function formatForPath(path: string): Format | null {
  const p = path.split("?")[0]!.replace(/\/+$/, "");
  if (/\/messages$/.test(p)) return anthropic;
  if (/\/responses$/.test(p)) return responses;
  if (/\/chat\/completions$/.test(p)) return chat;
  if (/:(?:stream)?[gG]enerateContent$/.test(p)) return gemini;
  return null;
}
