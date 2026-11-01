import { randomUUID } from 'node:crypto';
import { buildOrderTools } from '../../../../../src/features/assistant/application/tools/order-tools.js';
import { AskAssistant } from '../../../../../src/features/assistant/application/usecases/ask-assistant.js';
import { FakeLlmClient } from '../../../../../src/features/assistant/infrastructure/fake-llm.client.js';
import {
  orderSummary,
  StubOrderQueries,
} from '../../../../support/stub-order-queries.js';
import { StubModelCallBudget } from '../../../../support/stub-model-call-budget.js';

describe('FakeLlmClient', () => {
  let queries: StubOrderQueries;
  let assistant: AskAssistant;

  beforeEach(() => {
    queries = new StubOrderQueries();
    assistant = new AskAssistant(
      new FakeLlmClient(),
      buildOrderTools(queries),
      new StubModelCallBudget(),
    );
  });

  it('looks up the order the question names and explains its state', async () => {
    const orderId = randomUUID();
    queries.details.set(orderId, {
      ...orderSummary(orderId),
      items: null,
      events: [],
    });

    const result = await assistant.execute(`¿Por qué se rechazó ${orderId}?`);

    expect(result).toEqual({
      answer: `El pedido ${orderId} está rechazado (motivo: insufficient stock for product SKU-005).`,
      outcome: 'answered',
      citations: [{ orderId, eventIds: [] }],
      toolCalls: [{ name: 'get_order_timeline', args: { order_id: orderId } }],
      model: 'fake',
      usage: { input: 0, output: 0 },
    });
  });

  it('says so when the order is unknown', async () => {
    const orderId = randomUUID();

    const result = await assistant.execute(`¿Y el pedido ${orderId}?`);

    expect(result).toMatchObject({
      answer: `No encontré el pedido ${orderId}.`,
      outcome: 'no_data',
    });
  });

  it('lists the latest orders when the question names none', async () => {
    const [first, second] = [randomUUID(), randomUUID()];
    queries.orders = [
      orderSummary(first, {
        status: 'confirmed',
        stockResult: 'reserved',
        rejectionReason: null,
      }),
      orderSummary(second),
    ];

    const result = await assistant.execute('¿Qué pasó hoy?');

    expect(queries.searches).toEqual([{ limit: 5 }]);
    expect(result).toMatchObject({
      answer: `Encontré 2 pedidos: ${first} (confirmado), ${second} (rechazado).`,
      outcome: 'answered',
      toolCalls: [{ name: 'search_orders', args: { limit: 5 } }],
    });
  });

  it('says so when there are no orders', async () => {
    const result = await assistant.execute('¿Qué pasó hoy?');

    expect(result).toMatchObject({
      answer: 'No encontré pedidos.',
      outcome: 'no_data',
    });
  });
});
