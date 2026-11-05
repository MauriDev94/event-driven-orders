import {
  LlmClient,
  LlmQuotaExceededError,
  type LlmRequest,
  type LlmTurn,
} from '../../../src/features/assistant/application/contracts/llm-client.js';
import { FakeLlmClient } from '../../../src/features/assistant/infrastructure/fake-llm.client.js';
import { EVAL_CASES, EVAL_ORDERS } from '../../../eval/cases.js';
import { formatReport, runEval } from '../../../eval/runner.js';

class QuotaSpentLlmClient extends LlmClient {
  readonly model = 'spent';
  calls = 0;

  async complete(_request: LlmRequest): Promise<LlmTurn> {
    this.calls += 1;
    throw new LlmQuotaExceededError('the model ran out of quota');
  }
}

describe('the eval cases', () => {
  it('have unique ids and only cite orders of the catalog', () => {
    const ids = EVAL_CASES.map((evalCase) => evalCase.id);
    const known = new Set(EVAL_ORDERS.map((order) => order.orderId));
    const cited = EVAL_CASES.flatMap((evalCase) => [
      ...(evalCase.expect.cites ?? []),
      ...(evalCase.expect.notCites ?? []),
    ]);

    expect(new Set(ids).size).toBe(ids.length);
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(15);
    expect(cited.filter((orderId) => !known.has(orderId))).toEqual([]);
    expect(EVAL_CASES.some((evalCase) => evalCase.kind === 'adversarial')).toBe(
      true,
    );
  });
});

describe('runEval', () => {
  it('runs every case and scores it, without network', async () => {
    const report = await runEval({ llm: new FakeLlmClient() });

    expect(report.model).toBe('fake');
    expect(report.total).toBe(EVAL_CASES.length);
    expect(report.results).toHaveLength(EVAL_CASES.length);
    expect(
      report.results.find((r) => r.id === 'rejection-reason'),
    ).toMatchObject({ passed: true, failures: [], outcome: 'answered' });
    expect(report.passed).toBe(report.results.filter((r) => r.passed).length);
    expect(report.modelCalls).toBeGreaterThanOrEqual(EVAL_CASES.length);
  });

  it('stops at the first quota error instead of spending more', async () => {
    const llm = new QuotaSpentLlmClient();

    const report = await runEval({ llm });

    expect(llm.calls).toBe(1);
    expect(report.stoppedEarly).toMatch(/quota/);
    expect(report.results[0]).toMatchObject({
      passed: false,
      error: 'the model ran out of quota',
    });
    expect(report.results.slice(1).every((r) => r.error === 'not run')).toBe(
      true,
    );
    expect(report.passed).toBe(0);
  });

  it('stops when the run spends its cap of model calls', async () => {
    const report = await runEval({
      llm: new FakeLlmClient(),
      maxModelCalls: 3,
    });

    expect(report.modelCalls).toBe(3);
    expect(report.stoppedEarly).toMatch(/budget/);
  });

  it('spaces the model calls by the minimum interval', async () => {
    let clock = 0;
    const waits: number[] = [];
    const [first] = EVAL_CASES;

    await runEval({
      llm: new FakeLlmClient(),
      cases: first === undefined ? [] : [first],
      minIntervalMs: 4_000,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });

    // The first call goes right away; the second waits the whole interval.
    expect(waits).toEqual([4_000]);
  });
});

describe('formatReport', () => {
  it('prints a row per case and the total score', async () => {
    const report = await runEval({ llm: new FakeLlmClient() });

    const text = formatReport(report);

    expect(text).toContain(
      `fake: ${report.passed}/${report.total} (${Math.round((100 * report.passed) / report.total)} %)`,
    );
    for (const evalCase of EVAL_CASES) expect(text).toContain(evalCase.id);
  });
});
