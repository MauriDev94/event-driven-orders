import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service.js';
import {
  Prisma,
  type OrderEventLog,
  type OrderView as OrderViewRow,
} from '../../../generated/prisma/client.js';
import {
  ConcurrentUpdateError,
  type EventLogEntry,
  OrderHistoryRepository,
  type OrderHistoryTransaction,
  type OrderTimeline,
  type StoredOrderView,
} from '../application/contracts/order-history.repository.js';
import type { OrderItem } from '../domain/order-history-event.js';
import { OrderView } from '../domain/order-view.js';

/** Items as stored in the jsonb column: the wire format's snake_case. */
type StoredItem = {
  product_id: string;
  quantity: number;
  unit_price: string;
};

const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class PrismaOrderHistoryRepository extends OrderHistoryRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  inTransaction<T>(
    work: (tx: OrderHistoryTransaction) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction((tx) =>
      work(new PrismaOrderHistoryTransaction(tx)),
    );
  }

  async findTimeline(orderId: string): Promise<OrderTimeline | null> {
    const row = await this.prisma.orderView.findUnique({ where: { orderId } });
    if (row === null) return null;
    const events = await this.prisma.orderEventLog.findMany({
      where: { orderId },
      orderBy: [{ occurredAt: 'asc' }, { receivedAt: 'asc' }],
    });
    return { view: toDomain(row), events: events.map(toEntry) };
  }
}

class PrismaOrderHistoryTransaction implements OrderHistoryTransaction {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async recordEvent(entry: EventLogEntry): Promise<boolean> {
    // ON CONFLICT DO NOTHING: a redelivered event inserts no row.
    const { count } = await this.tx.orderEventLog.createMany({
      data: [{ ...entry, payload: entry.payload as Prisma.InputJsonValue }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async findView(orderId: string): Promise<StoredOrderView | null> {
    const row = await this.tx.orderView.findUnique({ where: { orderId } });
    return row === null ? null : { view: toDomain(row), version: row.version };
  }

  async saveView(
    view: OrderView,
    expectedVersion: number | null,
  ): Promise<void> {
    const data = toRow(view);
    if (expectedVersion === null) {
      try {
        await this.tx.orderView.create({ data });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === UNIQUE_VIOLATION
        ) {
          throw new ConcurrentUpdateError(view.orderId);
        }
        throw error;
      }
      return;
    }
    const { count } = await this.tx.orderView.updateMany({
      where: { orderId: view.orderId, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });
    if (count === 0) throw new ConcurrentUpdateError(view.orderId);
  }
}

function toRow(view: OrderView) {
  return {
    orderId: view.orderId,
    customerId: view.customerId,
    status: view.status,
    stockResult: view.stockResult,
    rejectionReason: view.rejectionReason,
    totalAmount: view.totalAmount,
    items:
      view.items === null
        ? Prisma.DbNull
        : view.items.map((item): StoredItem => ({
            product_id: item.productId,
            quantity: item.quantity,
            unit_price: item.unitPrice,
          })),
    createdAt: view.createdAt,
    // Every projected event sets it, so a saved view always has one.
    lastEventAt: view.lastEventAt ?? new Date(),
  };
}

function toDomain(row: OrderViewRow): OrderView {
  const items = row.items as StoredItem[] | null;
  return OrderView.restore({
    orderId: row.orderId,
    customerId: row.customerId,
    status: row.status,
    stockResult: row.stockResult,
    rejectionReason: row.rejectionReason,
    // numeric(14,2): toFixed keeps "20.00", which Decimal's toString would drop.
    totalAmount: row.totalAmount?.toFixed(2) ?? null,
    items:
      items?.map((item): OrderItem => ({
        productId: item.product_id,
        quantity: item.quantity,
        unitPrice: item.unit_price,
      })) ?? null,
    createdAt: row.createdAt,
    lastEventAt: row.lastEventAt,
  });
}

function toEntry(row: OrderEventLog): EventLogEntry {
  return {
    eventId: row.eventId,
    orderId: row.orderId,
    eventType: row.eventType,
    occurredAt: row.occurredAt,
    correlationId: row.correlationId,
    payload: row.payload,
  };
}
