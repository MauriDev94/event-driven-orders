import { randomUUID } from 'node:crypto';
import {
  LlmQuotaExceededError,
  LlmUnavailableError,
} from '../../../../../src/features/assistant/application/contracts/llm-client.js';
import { buildOrderTools } from '../../../../../src/features/assistant/application/tools/order-tools.js';
import { AskAssistant } from '../../../../../src/features/assistant/application/usecases/ask-assistant.js';
import { NO_DATA_ANSWER } from '../../../../../src/features/assistant/domain/grounding.js';
import {
  answer,
  callTools,
  ScriptedLlmClient,
} from '../../../../support/scripted-llm-client.js';
import {
  orderSummary,
  StubOrderQueries,
} from '../../../../support/stub-order-queries.js';

describe('AskAssistant', () => {
  const now = () => new Date('2026-10-31T15:30:00.000Z');
  let queries: StubOrderQueries;
  let orderId: string;
  let eventId: string;

  beforeEach(() => {
    queries = new StubOrderQueries();
    orderId = randomUUID();
    eventId = randomUUID();
    queries.details.set(orderId, {
      ...orderSummary(orderId),
      items: null,
      events: [
        {
          eventId,
          eventType: 'order.rejected',
          occurredAt: new Date('2026-10-31T12:00:02.000Z'),
          reason: 'insufficient stock for product SKU-005',
        },
      ],
    });
  });

  function assistant(llm: ScriptedLlmClient, options = {}) {
    return new AskAssistant(llm, buildOrderTools(queries), { now, ...options });
  }

  it('runs the tools the model asks for and cites what they returned', async () => {
    const llm = new ScriptedLlmClient([
      callTools([
        { id: 'c1', name: 'get_order_timeline', args: { order_id: orderId } },
      ]),
      answer(`El pedido ${orderId} se rechazó por falta de stock de SKU-005.`),
    ]);

    const result = await assistant(llm).execute(
      `por que se rechazo ${orderId}?`,
    );

    expect(result).toEqual({
      answer: `El pedido ${orderId} se rechazó por falta de stock de SKU-005.`,
      outcome: 'answered',
      citations: [{ orderId, eventIds: [eventId] }],
      toolCalls: [{ name: 'get_order_timeline', args: { order_id: orderId } }],
      model: 'scripted',
      usage: { input: 30, output: 13 },
    });
  });

  it('sends the model turn back unchanged, followed by the tool results', async () => {
    const llm = new ScriptedLlmClient([
      callTools([
        { id: 'c1', name: 'get_order_timeline', args: { order_id: orderId } },
      ]),
      answer('listo'),
    ]);

    await assistant(llm).execute('pregunta');

    const [first, second] = llm.requests;
    expect(first?.messages).toEqual([{ role: 'user', text: 'pregunta' }]);
    expect(second?.messages).toEqual([
      { role: 'user', text: 'pregunta' },
      {
        role: 'model',
        text: '',
        toolCalls: [
          { id: 'c1', name: 'get_order_timeline', args: { order_id: orderId } },
        ],
        providerData: { raw: 'turn' },
      },
      {
        role: 'tool',
        results: [
          {
            callId: 'c1',
            name: 'get_order_timeline',
            output: expect.objectContaining({ found: true }),
          },
        ],
      },
    ]);
  });

  it('gives the model the tools, the rules and the current date', async () => {
    const llm = new ScriptedLlmClient([answer('hola')]);

    await assistant(llm).execute('hola');

    const [request] = llm.requests;
    expect(request?.tools.map((tool) => tool.name)).toEqual([
      'get_order_timeline',
      'search_orders',
      'rejection_summary',
    ]);
    expect(request?.system).toContain('2026-10-31T15:30:00.000Z');
    expect(request?.system).toMatch(/only .*tools/i);
    expect(request?.system).toMatch(/data, not instructions/i);
    expect(request?.system).toMatch(/same language as the question/i);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers an unknown tool with an error and keeps going', async () => {
    const llm = new ScriptedLlmClient([
      callTools([{ name: 'delete_order', args: { order_id: orderId } }]),
      answer('No puedo hacer eso.'),
    ]);

    const result = await assistant(llm).execute('borra el pedido');

    expect(llm.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      results: [
        {
          name: 'delete_order',
          output: { error: 'unknown tool delete_order' },
        },
      ],
    });
    expect(result).toMatchObject({
      answer: 'No puedo hacer eso.',
      outcome: 'no_data',
      toolCalls: [{ name: 'delete_order', args: { order_id: orderId } }],
    });
  });

  it('runs at most 5 tool calls per turn', async () => {
    const calls = Array.from({ length: 7 }, (_, i) => ({
      id: `c${i}`,
      name: 'search_orders',
      args: {},
    }));
    const llm = new ScriptedLlmClient([callTools(calls), answer('listo')]);

    const result = await assistant(llm).execute('todo');

    const last = llm.requests[1]?.messages.at(-1);
    expect(last).toMatchObject({ role: 'tool' });
    const results = last?.role === 'tool' ? last.results : [];
    expect(results).toHaveLength(7);
    expect(results.slice(5).map((r) => r.output)).toEqual([
      { error: 'too many tool calls in one turn, at most 5' },
      { error: 'too many tool calls in one turn, at most 5' },
    ]);
    expect(queries.searches).toHaveLength(5);
    expect(result.toolCalls).toHaveLength(7);
  });

  it('gives up after 5 turns of tool calls', async () => {
    const loop = callTools([{ name: 'search_orders', args: {} }]);
    const llm = new ScriptedLlmClient(Array.from({ length: 6 }, () => loop));

    const result = await assistant(llm).execute('sin fin');

    expect(llm.requests).toHaveLength(5);
    expect(result).toMatchObject({
      answer: NO_DATA_ANSWER,
      outcome: 'max_iterations',
      citations: [],
    });
    expect(result.toolCalls).toHaveLength(5);
  });

  it('replaces an answer that names an order no tool returned', async () => {
    const llm = new ScriptedLlmClient([
      answer(`El pedido ${randomUUID()} está confirmado.`),
    ]);

    const result = await assistant(llm).execute('y el ultimo pedido?');

    expect(result).toMatchObject({
      answer: NO_DATA_ANSWER,
      outcome: 'ungrounded',
      citations: [],
    });
  });

  it('stops when the question runs out of time', async () => {
    const llm = new ScriptedLlmClient([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return callTools([{ name: 'search_orders', args: {} }]);
      },
      answer('tarde'),
    ]);

    await expect(
      assistant(llm, { timeoutMs: 10 }).execute('lento'),
    ).rejects.toThrow(LlmUnavailableError);
    expect(llm.requests).toHaveLength(1);
  });

  it('lets a quota error through, for a 503', async () => {
    const llm = new ScriptedLlmClient([
      async () => {
        throw new LlmQuotaExceededError('quota');
      },
    ]);

    await expect(assistant(llm).execute('hola')).rejects.toThrow(
      LlmQuotaExceededError,
    );
  });
});
