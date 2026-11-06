import type { Citation, Evidence } from './evidence.js';
import { amountsIn, skusIn } from './facts.js';

/**
 * - `answered`: the answer rests on orders the tools returned.
 * - `no_data`: the tools found nothing, or the model said nothing.
 * - `ungrounded`: the answer named an ID, an amount or a SKU no tool
 *   returned, so it was replaced.
 * - `leaked`: the answer repeated part of the system prompt, so it was
 *   replaced (`prompt-leak.ts`).
 * - `max_iterations`: the agent ran out of turns before answering.
 */
export type AnswerOutcome =
  'answered' | 'no_data' | 'ungrounded' | 'leaked' | 'max_iterations';

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
 * Whether every amount and SKU of the answer came from the tools or the
 * question. An amount the model computed (a sum of totals) isn't in either,
 * so it counts as made up too: the prompt asks the model to copy amounts.
 */
function factsAreGrounded(
  answer: string,
  question: string,
  evidence: Evidence,
): boolean {
  const askedAmounts = amountsIn(question);
  const askedSkus = skusIn(question);
  return (
    [...amountsIn(answer)].every(
      (amount) => evidence.hasAmount(amount) || askedAmounts.has(amount),
    ) &&
    [...skusIn(answer)].every(
      (sku) => evidence.hasSku(sku) || askedSkus.has(sku),
    )
  );
}

/**
 * Checks the model's final text against what the tools returned. An ID, an
 * amount or a SKU the tools never returned (and the question didn't bring)
 * means the model made it up, so the whole answer is replaced: a half-true
 * answer about orders is worse than none. Citations come from the evidence,
 * never from the model.
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

  if (!factsAreGrounded(answer, question, evidence)) {
    return { text: NO_DATA_ANSWER, outcome: 'ungrounded', citations: [] };
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
