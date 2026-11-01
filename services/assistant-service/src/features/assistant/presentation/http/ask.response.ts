import type { AskAssistantResult } from '../../application/usecases/ask-assistant.js';

/** snake_case, like the other services' APIs. */
export interface AskResponse {
  answer: string;
  outcome: string;
  citations: { order_id: string; event_ids: string[] }[];
  tool_calls: { name: string; args: Record<string, unknown> }[];
  model: string;
}

export function toAskResponse(result: AskAssistantResult): AskResponse {
  return {
    answer: result.answer,
    outcome: result.outcome,
    citations: result.citations.map((citation) => ({
      order_id: citation.orderId,
      event_ids: citation.eventIds,
    })),
    tool_calls: result.toolCalls,
    model: result.model,
  };
}
