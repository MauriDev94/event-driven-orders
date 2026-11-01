import type { Citation, Evidence } from './evidence.js';

/**
 * - `answered`: the answer rests on orders the tools returned.
 * - `no_data`: the tools found nothing, or the model said nothing.
 * - `ungrounded`: the answer named an ID no tool returned, so it was replaced.
 * - `max_iterations`: the agent ran out of turns before answering.
 */
export type AnswerOutcome =
  'answered' | 'no_data' | 'ungrounded' | 'max_iterations';

export interface GroundedAnswer {
  text: string;
  outcome: AnswerOutcome;
  citations: Citation[];
}

export const NO_DATA_ANSWER = 'No tengo datos suficientes para responder eso.';

const MAX_CITATIONS = 20;

// Order and event IDs are UUIDs (uuid4 in order-service, and in every event).
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function idsIn(text: string): Set<string> {
  return new Set([...text.matchAll(UUID)].map(([id]) => id.toLowerCase()));
}

/**
 * Checks the model's final text against what the tools returned. An ID the
 * tools never returned (and the question didn't bring) means the model made
 * it up, so the whole answer is replaced: a half-true answer about orders is
 * worse than none. Citations come from the evidence, never from the model.
 */
export function groundAnswer(
  text: string,
  question: string,
  evidence: Evidence,
): GroundedAnswer {
  const answer = text.trim();
  if (answer === '') {
    return { text: NO_DATA_ANSWER, outcome: 'no_data', citations: [] };
  }

  const asked = idsIn(question);
  const cited = new Set<string>();
  for (const id of idsIn(answer)) {
    const orderId = evidence.orderOf(id);
    if (orderId !== undefined) cited.add(orderId);
    else if (!asked.has(id)) {
      return { text: NO_DATA_ANSWER, outcome: 'ungrounded', citations: [] };
    }
  }

  const citations = evidence
    .citations(cited.size > 0 ? cited : undefined)
    .slice(0, MAX_CITATIONS);
  return {
    text: answer,
    outcome: citations.length > 0 ? 'answered' : 'no_data',
    citations,
  };
}
