// Token usage of one model call, as read from the API's responses (the reading
// itself is in src/turn.ts, together with the rest of the turn).

export interface TokenUsage {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** Share of cache_creation_input_tokens written with the 1-hour TTL, when
   * the response reports the split (usage.cache_creation.ephemeral_1h_input_tokens). */
  cache_write_1h_tokens?: number;
}
