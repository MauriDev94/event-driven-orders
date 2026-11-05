import { randomUUID } from 'node:crypto';
import { type CaseRun, scoreCase } from '../../../eval/score.js';

describe('scoreCase', () => {
  const order = randomUUID();
  const other = randomUUID();

  function run(overrides: Partial<CaseRun> = {}): CaseRun {
    return {
      answer: `El pedido ${order} se rechazó por falta de stock de SKU-005; sumaba $1.250.`,
      outcome: 'answered',
      citations: [{ orderId: order, eventIds: [] }],
      toolCalls: [{ name: 'get_order_timeline' }],
      ...overrides,
    };
  }

  it('passes when every expectation holds', () => {
    expect(
      scoreCase(
        {
          outcomes: ['answered'],
          cites: [order],
          notCites: [other],
          mentions: ['sku-005', /falta de stock/],
          notMentions: ['confirmado'],
          amounts: [125_000],
          tools: ['get_order_timeline'],
        },
        run(),
      ),
    ).toEqual([]);
  });

  it('fails on an outcome the case does not allow', () => {
    expect(scoreCase({ outcomes: ['no_data'] }, run())).toEqual([
      'outcome answered, expected no_data',
    ]);
  });

  it('fails when an order that must be cited is missing, or one that must not is there', () => {
    const failures = scoreCase({ cites: [other], notCites: [order] }, run());

    expect(failures).toEqual([
      `does not cite ${other}`,
      `cites ${order}, which it should not`,
    ]);
  });

  it('matches mentions as case-insensitive text or as a pattern', () => {
    expect(scoreCase({ mentions: ['SKU-007', /confirmad/i] }, run())).toEqual([
      'does not mention SKU-007',
      'does not mention /confirmad/i',
    ]);
    expect(scoreCase({ notMentions: [/rechaz/] }, run())).toEqual([
      'mentions /rechaz/, which it should not',
    ]);
  });

  it('compares amounts by value, however the answer writes them', () => {
    expect(scoreCase({ amounts: [125_000] }, run())).toEqual([]);
    expect(scoreCase({ amounts: [2_000] }, run())).toEqual([
      'does not mention the amount 20.00',
    ]);
  });

  it('fails when a tool that should have been called was not', () => {
    expect(scoreCase({ tools: ['rejection_summary'] }, run())).toEqual([
      'did not call rejection_summary',
    ]);
  });
});
