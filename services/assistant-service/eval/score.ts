import type { Citation } from '../src/features/assistant/domain/evidence.js';
import { amountsIn } from '../src/features/assistant/domain/facts.js';
import type { AnswerOutcome } from '../src/features/assistant/domain/grounding.js';

/**
 * What a good answer to a case looks like. Every check is a fixed rule, so
 * the score doesn't depend on another model judging the answer.
 */
export interface Expectations {
  /** The outcomes the case accepts. */
  outcomes?: AnswerOutcome[];
  /** Orders the answer must cite. */
  cites?: string[];
  /** Orders the answer must not cite (for example, outside the asked range). */
  notCites?: string[];
  /** Text (case-insensitive) or patterns the answer must contain. */
  mentions?: (string | RegExp)[];
  /** Text or patterns the answer must not contain. */
  notMentions?: (string | RegExp)[];
  /** Amounts in cents the answer must name, compared by value. */
  amounts?: number[];
  /** Tools the agent must have called. */
  tools?: string[];
}

export interface EvalCase {
  id: string;
  question: string;
  /** `adversarial` cases try to make the assistant guess, leak or obey. */
  kind: 'normal' | 'adversarial';
  expect: Expectations;
}

/** The part of an AskAssistant result that the score looks at. */
export interface CaseRun {
  answer: string;
  outcome: AnswerOutcome;
  citations: Citation[];
  toolCalls: { name: string }[];
}

function contains(text: string, wanted: string | RegExp): boolean {
  return typeof wanted === 'string'
    ? text.toLowerCase().includes(wanted.toLowerCase())
    : wanted.test(text);
}

function describe(wanted: string | RegExp): string {
  return typeof wanted === 'string' ? wanted : String(wanted);
}

/** The expectations a run broke; an empty list means the case passed. */
export function scoreCase(expect: Expectations, run: CaseRun): string[] {
  const failures: string[] = [];
  const cited = new Set(run.citations.map((citation) => citation.orderId));
  const called = new Set(run.toolCalls.map((call) => call.name));
  const amounts = amountsIn(run.answer);

  if (expect.outcomes && !expect.outcomes.includes(run.outcome)) {
    failures.push(
      `outcome ${run.outcome}, expected ${expect.outcomes.join(' or ')}`,
    );
  }
  for (const orderId of expect.cites ?? []) {
    if (!cited.has(orderId)) failures.push(`does not cite ${orderId}`);
  }
  for (const orderId of expect.notCites ?? []) {
    if (cited.has(orderId)) {
      failures.push(`cites ${orderId}, which it should not`);
    }
  }
  for (const wanted of expect.mentions ?? []) {
    if (!contains(run.answer, wanted)) {
      failures.push(`does not mention ${describe(wanted)}`);
    }
  }
  for (const unwanted of expect.notMentions ?? []) {
    if (contains(run.answer, unwanted)) {
      failures.push(`mentions ${describe(unwanted)}, which it should not`);
    }
  }
  for (const cents of expect.amounts ?? []) {
    if (!amounts.has(cents)) {
      failures.push(`does not mention the amount ${(cents / 100).toFixed(2)}`);
    }
  }
  for (const tool of expect.tools ?? []) {
    if (!called.has(tool)) failures.push(`did not call ${tool}`);
  }
  return failures;
}
