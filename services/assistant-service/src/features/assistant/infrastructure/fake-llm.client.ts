import {
  LlmClient,
  type LlmRequest,
  type LlmTurn,
  type ModelMessage,
} from '../application/contracts/llm-client.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const STATUS_ES: Record<string, string> = {
  pending: 'pendiente',
  confirmed: 'confirmado',
  rejected: 'rechazado',
};

interface OrderOutput {
  order_id: string;
  status: string;
  rejection_reason: string | null;
}

/**
 * A model with fixed rules, so the service runs without an API key
 * (`LLM_PROVIDER=fake`, the Compose default) and the e2e tests can ask real
 * questions. A question with an order ID gets that order's timeline; any
 * other gets the latest orders. The answer is a fixed sentence built from
 * the tool output, so it goes through the same grounding as a real one.
 */
export class FakeLlmClient extends LlmClient {
  readonly model = 'fake';

  async complete({ messages }: LlmRequest): Promise<LlmTurn> {
    const last = messages.at(-1);
    if (last?.role === 'tool') {
      const output = last.results[0]?.output ?? {};
      return turn({ role: 'model', text: describe(output), toolCalls: [] });
    }
    const question = last?.role === 'user' ? last.text : '';
    const orderId = UUID.exec(question)?.[0];
    return turn({
      role: 'model',
      text: '',
      toolCalls: [
        orderId === undefined
          ? { name: 'search_orders', args: { limit: 5 } }
          : { name: 'get_order_timeline', args: { order_id: orderId } },
      ],
    });
  }
}

function turn(message: ModelMessage): LlmTurn {
  return { message, usage: { input: 0, output: 0 } };
}

function describe(output: Record<string, unknown>): string {
  if (output['found'] === false) {
    return `No encontré el pedido ${String(output['order_id'])}.`;
  }
  if (output['found'] === true) {
    const order = output['order'] as OrderOutput;
    const reason = order.rejection_reason
      ? ` (motivo: ${order.rejection_reason})`
      : '';
    return `El pedido ${order.order_id} está ${STATUS_ES[order.status] ?? order.status}${reason}.`;
  }
  const orders = (output['orders'] as OrderOutput[] | undefined) ?? [];
  if (orders.length === 0) return 'No encontré pedidos.';
  const list = orders
    .map(
      (order) =>
        `${order.order_id} (${STATUS_ES[order.status] ?? order.status})`,
    )
    .join(', ');
  return `Encontré ${orders.length} pedidos: ${list}.`;
}
