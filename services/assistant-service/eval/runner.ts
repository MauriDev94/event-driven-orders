import { setTimeout as delay } from 'node:timers/promises';
import {
  LlmClient,
  LlmQuotaExceededError,
  type LlmRequest,
  type LlmTurn,
} from '../src/features/assistant/application/contracts/llm-client.js';
import { ModelCallBudget } from '../src/features/assistant/application/contracts/model-call-budget.js';
import type { OrderDetails } from '../src/features/assistant/application/contracts/order-queries.js';
import { buildOrderTools } from '../src/features/assistant/application/tools/order-tools.js';
import { AskAssistant } from '../src/features/assistant/application/usecases/ask-assistant.js';
import { EVAL_CASES, EVAL_CUSTOMER, EVAL_NOW, EVAL_ORDERS } from './cases.js';
import { InMemoryOrderQueries } from './in-memory-order-queries.js';
import { type EvalCase, scoreCase } from './score.js';

/**
 * Leaves at least `minIntervalMs` between the starts of two model calls, so
 * a run stays under the free plan's requests per minute (15 for Flash Lite).
 */
class ThrottledLlmClient extends LlmClient {
  private last: number | undefined;

  constructor(
    private readonly inner: LlmClient,
    private readonly minIntervalMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    super();
  }

  get model(): string {
    return this.inner.model;
  }

  async complete(request: LlmRequest): Promise<LlmTurn> {
    if (this.last !== undefined) {
      const wait = this.last + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.last = this.now();
    return this.inner.complete(request);
  }
}

/** A cap on the model calls of the whole run, on top of the daily one. */
class RunBudget extends ModelCallBudget {
  taken = 0;

  constructor(private readonly limit: number) {
    super();
  }

  async take(): Promise<boolean> {
    if (this.taken >= this.limit) return false;
    this.taken += 1;
    return true;
  }
}

const SERVICE_TIMEOUT_MS = 30_000;
const MAX_TURNS = 5;

/**
 * The service gives a question 30 s. The throttle waits before each of its
 * up to 5 model turns, and that wait is the eval's doing, not the model's
 * slowness, so it is added on top.
 */
export function questionTimeoutMs(minIntervalMs: number): number {
  return SERVICE_TIMEOUT_MS + MAX_TURNS * minIntervalMs;
}

export interface EvalOptions {
  llm: LlmClient;
  cases?: readonly EvalCase[];
  orders?: readonly OrderDetails[];
  /** 0 by default; the CLI sets it for Gemini. */
  minIntervalMs?: number;
  /** Cap on model calls for the run (each question takes 2 to 5). */
  maxModelCalls?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CaseResult {
  id: string;
  kind: EvalCase['kind'];
  question: string;
  passed: boolean;
  failures: string[];
  outcome?: string;
  answer?: string;
  toolCalls: string[];
  error?: string;
}

export interface EvalReport {
  model: string;
  passed: number;
  total: number;
  modelCalls: number;
  usage: { input: number; output: number };
  results: CaseResult[];
  /** Why the run stopped before the last case, if it did. */
  stoppedEarly?: string;
}

/**
 * Asks every case through the real AskAssistant (same loop, tools and
 * grounding as the service) over a fixed in-memory catalog, and scores each
 * answer. A quota error stops the run: retrying would only spend more.
 */
export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const cases = options.cases ?? EVAL_CASES;
  const budget = new RunBudget(options.maxModelCalls ?? 100);
  const llm = new ThrottledLlmClient(
    options.llm,
    options.minIntervalMs ?? 0,
    options.now ?? Date.now,
    options.sleep ?? ((ms) => delay(ms)),
  );
  const assistant = new AskAssistant(
    llm,
    (customerId) =>
      buildOrderTools(
        new InMemoryOrderQueries(options.orders ?? EVAL_ORDERS),
        customerId,
      ),
    budget,
    {
      now: () => EVAL_NOW,
      timeoutMs: questionTimeoutMs(options.minIntervalMs ?? 0),
    },
  );
  const usage = { input: 0, output: 0 };
  const results: CaseResult[] = [];
  let stoppedEarly: string | undefined;

  for (const evalCase of cases) {
    const base = {
      id: evalCase.id,
      kind: evalCase.kind,
      question: evalCase.question,
    };
    if (stoppedEarly !== undefined) {
      results.push({
        ...base,
        passed: false,
        failures: [],
        toolCalls: [],
        error: 'not run',
      });
      continue;
    }
    try {
      const result = await assistant.execute(evalCase.question, EVAL_CUSTOMER);
      usage.input += result.usage.input;
      usage.output += result.usage.output;
      const failures = scoreCase(evalCase.expect, result);
      results.push({
        ...base,
        passed: failures.length === 0,
        failures,
        outcome: result.outcome,
        answer: result.answer,
        toolCalls: result.toolCalls.map((call) => call.name),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        ...base,
        passed: false,
        failures: [],
        toolCalls: [],
        error: message,
      });
      if (error instanceof LlmQuotaExceededError) stoppedEarly = message;
    }
  }

  return {
    model: options.llm.model,
    passed: results.filter((result) => result.passed).length,
    total: cases.length,
    modelCalls: budget.taken,
    usage,
    results,
    ...(stoppedEarly === undefined ? {} : { stoppedEarly }),
  };
}

/** What failed and what the model said, so a failure can be judged. */
function detail(result: CaseResult): string {
  const answer = result.answer ?? '';
  return result.failures.length === 0
    ? answer
    : `${result.failures.join('; ')} -- ${answer}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** The report as Markdown: the score, then one row per case. */
export function formatReport(report: EvalReport): string {
  const percent =
    report.total === 0 ? 0 : Math.round((100 * report.passed) / report.total);
  const adversarial = report.results.filter(
    (result) => result.kind === 'adversarial',
  );
  const lines = [
    `## ${report.model}: ${report.passed}/${report.total} (${percent} %)`,
    '',
    `Adversarial cases: ${adversarial.filter((result) => result.passed).length}/${adversarial.length}. ` +
      `Model calls: ${report.modelCalls}. Tokens: ${report.usage.input} in, ${report.usage.output} out.`,
    ...(report.stoppedEarly === undefined
      ? []
      : ['', `**Stopped early:** ${report.stoppedEarly}`]),
    '',
    '| Case | Kind | Result | Outcome | Tools | Detail |',
    '|---|---|---|---|---|---|',
    ...report.results
      .map((result) =>
        [
          result.id,
          result.kind,
          result.passed ? 'pass' : 'FAIL',
          result.outcome ?? '-',
          result.toolCalls.join(', ') || '-',
          cell(result.error ?? detail(result)),
        ].join(' | '),
      )
      .map((row) => `| ${row} |`),
  ];
  return lines.join('\n');
}
