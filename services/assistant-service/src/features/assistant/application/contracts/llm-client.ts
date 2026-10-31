/** A tool the model may call: its arguments are described with JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  /** Set when the provider pairs calls and results by ID. */
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId?: string;
  name: string;
  /** JSON for the model; an `error` key reports a failed call. */
  output: Record<string, unknown>;
}

export interface UserMessage {
  role: 'user';
  text: string;
}

export interface ModelMessage {
  role: 'model';
  text: string;
  toolCalls: ToolCall[];
  /**
   * The provider's own copy of this turn, sent back unchanged on the next
   * request. Gemini needs it: its thought signatures must return as they came.
   */
  providerData?: unknown;
}

export interface ToolResultsMessage {
  role: 'tool';
  results: ToolResult[];
}

export type ConversationMessage =
  UserMessage | ModelMessage | ToolResultsMessage;

export interface LlmRequest {
  system: string;
  messages: readonly ConversationMessage[];
  tools: readonly ToolSpec[];
  /** Aborts the call when the question runs out of time. */
  signal: AbortSignal;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface LlmTurn {
  /** Tool calls to run, or none when the text is the final answer. */
  message: ModelMessage;
  usage: TokenUsage;
}

/**
 * Port of the model. It runs a single turn; the agent loop lives in
 * AskAssistant, so it doesn't depend on any provider and the fake covers it.
 */
export abstract class LlmClient {
  abstract readonly model: string;

  abstract complete(request: LlmRequest): Promise<LlmTurn>;
}

/** The provider refused for quota (Gemini's 429): retrying now won't help. */
export class LlmQuotaExceededError extends Error {
  override readonly name = 'LlmQuotaExceededError';
}

/** The provider failed, timed out or could not be reached. */
export class LlmUnavailableError extends Error {
  override readonly name = 'LlmUnavailableError';
}
