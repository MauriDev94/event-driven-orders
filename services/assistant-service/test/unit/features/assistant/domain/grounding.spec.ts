import { randomUUID } from 'node:crypto';
import {
  groundAnswer,
  NO_DATA_ANSWER,
} from '../../../../../src/features/assistant/domain/grounding.js';
import { Evidence } from '../../../../../src/features/assistant/domain/evidence.js';

describe('groundAnswer', () => {
  const order = randomUUID();
  const event = randomUUID();
  const otherOrder = randomUUID();

  function evidence(): Evidence {
    const seen = new Evidence();
    seen.add(order, [event]);
    seen.add(otherOrder);
    return seen;
  }

  it('cites only the orders the answer mentions', () => {
    const grounded = groundAnswer(
      `El pedido ${order} se rechazó por falta de stock.`,
      'por que se rechazo?',
      evidence(),
    );

    expect(grounded).toEqual({
      text: `El pedido ${order} se rechazó por falta de stock.`,
      outcome: 'answered',
      citations: [{ orderId: order, eventIds: [event] }],
    });
  });

  it('cites the order of a mentioned event', () => {
    const grounded = groundAnswer(
      `El evento ${event} rechazó el stock.`,
      '?',
      evidence(),
    );

    expect(grounded.citations).toEqual([{ orderId: order, eventIds: [event] }]);
  });

  it('cites every order the tools returned when the answer names none', () => {
    const grounded = groundAnswer(
      'Hoy se rechazaron 2 pedidos.',
      'cuantos?',
      evidence(),
    );

    expect(grounded.outcome).toBe('answered');
    expect(grounded.citations).toEqual([
      { orderId: order, eventIds: [event] },
      { orderId: otherOrder, eventIds: [] },
    ]);
  });

  it('matches IDs regardless of case', () => {
    const grounded = groundAnswer(
      `Pedido ${order.toUpperCase()}.`,
      '?',
      evidence(),
    );

    expect(grounded.outcome).toBe('answered');
    expect(grounded.citations).toEqual([{ orderId: order, eventIds: [event] }]);
  });

  it('replaces an answer that names an ID no tool returned', () => {
    const grounded = groundAnswer(
      `El pedido ${randomUUID()} se confirmó.`,
      '?',
      evidence(),
    );

    expect(grounded).toEqual({
      text: NO_DATA_ANSWER,
      outcome: 'ungrounded',
      citations: [],
    });
  });

  it('lets the answer repeat an ID the question brought', () => {
    const asked = randomUUID();

    const grounded = groundAnswer(
      `No encontré el pedido ${asked}.`,
      `que paso con ${asked}?`,
      new Evidence(),
    );

    expect(grounded).toEqual({
      text: `No encontré el pedido ${asked}.`,
      outcome: 'no_data',
      citations: [],
    });
  });

  it('reports no data when the tools returned no order', () => {
    const grounded = groundAnswer(
      'No hay pedidos en ese rango.',
      '?',
      new Evidence(),
    );

    expect(grounded.outcome).toBe('no_data');
    expect(grounded.text).toBe('No hay pedidos en ese rango.');
  });

  it('answers with the no-data text when the model said nothing', () => {
    expect(groundAnswer('   ', '?', evidence())).toEqual({
      text: NO_DATA_ANSWER,
      outcome: 'no_data',
      citations: [],
    });
  });

  it('caps the citations at 20 orders', () => {
    const many = new Evidence();
    for (let i = 0; i < 25; i++) many.add(randomUUID());

    expect(groundAnswer('Muchos pedidos.', '?', many).citations).toHaveLength(
      20,
    );
  });
});

describe('Evidence', () => {
  it('merges the events seen for the same order across tool calls', () => {
    const order = randomUUID();
    const [first, second] = [randomUUID(), randomUUID()];
    const seen = new Evidence();

    seen.add(order);
    seen.add(order, [first]);
    seen.add(order, [first, second]);

    expect(seen.citations()).toEqual([
      { orderId: order, eventIds: [first, second] },
    ]);
  });
});
