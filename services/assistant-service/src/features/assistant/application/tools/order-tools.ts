import { z } from 'zod';
import type { ToolSpec } from '../contracts/llm-client.js';
import type {
  OrderDetails,
  OrderQueries,
  OrderSummary,
  TimeRange,
} from '../contracts/order-queries.js';

export interface ToolRun {
  /** What the model sees. */
  output: Record<string, unknown>;
  /** The orders (and events) this run returned, for the citations. */
  evidence: { orderId: string; eventIds: string[] }[];
}

export interface AssistantTool {
  readonly spec: ToolSpec;
  /** Never throws for bad arguments: the error goes back to the model. */
  run(args: Record<string, unknown>): Promise<ToolRun>;
}

/** For the metrics: a name the model made up becomes `unknown`. */
export const TOOL_NAMES: ReadonlySet<string> = new Set([
  'get_order_timeline',
  'search_orders',
  'rejection_summary',
]);

/**
 * What a tool may send the model. Visitors choose the SKUs and the number of
 * lines, so nothing here may grow with the data (SEC-01). When a list is cut
 * the output says so and gives the total (exact for groups and items; the products of a group are counted over its 1,000 most recent orders). The model reads these as
 * tokens on every turn: 10 groups and 20 items are what a question needs to
 * see, and the worst case is about 19 KB, under the byte cap that
 * `AskAssistant` applies as a last resort.
 */
/** Rejection reasons embed a SKU, so each invented SKU is its own group. */
export const MAX_REJECTION_GROUPS = 10;
/** Products listed per rejection group. */
export const MAX_PRODUCT_IDS_PER_GROUP = 20;
/** Items of an order that `get_order_timeline` lists. */
export const MAX_TIMELINE_ITEMS = 20;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const dateBound = z
  .string()
  .refine(
    (value) =>
      DATE_ONLY.test(value) ||
      (value.includes('T') && Number.isFinite(Date.parse(value))),
    'must be an ISO 8601 date (2026-10-31) or date-time',
  );

const rangeShape = {
  from: dateBound
    .optional()
    .describe(
      'Orders created at or after this UTC date or date-time (ISO 8601).',
    ),
  to: dateBound
    .optional()
    .describe(
      'Orders created up to this UTC date or date-time; a date includes the whole day.',
    ),
};

/** `from` inclusive and `to` inclusive, as the range the port expects. */
function toRange(from?: string, to?: string): TimeRange {
  const range: TimeRange = {};
  if (from !== undefined) {
    range.from = new Date(DATE_ONLY.test(from) ? `${from}T00:00:00Z` : from);
  }
  if (to !== undefined) {
    range.until = DATE_ONLY.test(to)
      ? new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS)
      : new Date(Date.parse(to) + 1);
  }
  return range;
}

function defineTool<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.infer<S>) => Promise<ToolRun>,
): AssistantTool {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(schema, {
    io: 'input',
  });
  return {
    spec: { name, description, parameters },
    async run(args) {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const problems = parsed.error.issues
          .map(
            (issue) =>
              `${issue.path.join('.') || 'arguments'}: ${issue.message}`,
          )
          .join('; ');
        return {
          output: { error: `invalid arguments: ${problems}` },
          evidence: [],
        };
      }
      return handler(parsed.data);
    },
  };
}

function summary(order: OrderSummary) {
  return {
    order_id: order.orderId,
    status: order.status,
    stock_result: order.stockResult,
    rejection_reason: order.rejectionReason,
    total_amount: order.totalAmount,
    created_at: order.createdAt?.toISOString() ?? null,
    last_event_at: order.lastEventAt?.toISOString() ?? null,
  };
}

function details(order: OrderDetails) {
  const items = order.items?.slice(0, MAX_TIMELINE_ITEMS);
  const cut = order.items !== null && order.items.length > MAX_TIMELINE_ITEMS;
  return {
    ...summary(order),
    items:
      items?.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
        unit_price: item.unitPrice,
      })) ?? null,
    ...(cut ? { items_truncated: true, items_total: order.items?.length } : {}),
    events: order.events.map((event) => ({
      event_id: event.eventId,
      event_type: event.eventType,
      occurred_at: event.occurredAt.toISOString(),
      ...(event.reason === null ? {} : { reason: event.reason }),
    })),
  };
}

/**
 * The assistant's tools: read-only queries over the read model, with
 * snake_case output like the HTTP API. Nothing here can change an order.
 */
export function buildOrderTools(queries: OrderQueries): AssistantTool[] {
  return [
    defineTool(
      'get_order_timeline',
      'Current state of one order and every event received for it, oldest first, with the rejection reasons.',
      z.object({
        order_id: z.string().min(1).describe('The order ID (a UUID).'),
      }),
      async ({ order_id }) => {
        const order = await queries.timeline(order_id);
        if (order === null) {
          return { output: { found: false, order_id }, evidence: [] };
        }
        return {
          output: { found: true, order: details(order) },
          evidence: [
            {
              orderId: order.orderId,
              eventIds: order.events.map((event) => event.eventId),
            },
          ],
        };
      },
    ),
    defineTool(
      'search_orders',
      'Lists orders, most recent activity first, filtered by status, creation date range and product.',
      z.object({
        status: z.enum(['pending', 'confirmed', 'rejected']).optional(),
        ...rangeShape,
        product_id: z
          .string()
          .min(1)
          .optional()
          .describe('Only orders with this product, e.g. SKU-001.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('How many orders to return, 10 by default.'),
      }),
      async ({ status, from, to, product_id, limit }) => {
        const orders = await queries.search({
          ...(status === undefined ? {} : { status }),
          ...toRange(from, to),
          ...(product_id === undefined ? {} : { productId: product_id }),
          limit: limit ?? 10,
        });
        return {
          output: { count: orders.length, orders: orders.map(summary) },
          evidence: orders.map((order) => ({
            orderId: order.orderId,
            eventIds: [],
          })),
        };
      },
    ),
    defineTool(
      'rejection_summary',
      'Rejected orders grouped by rejection reason, with the products and orders of each group.',
      z.object(rangeShape),
      async ({ from, to }) => {
        const result = await queries.rejectionSummary(toRange(from, to), {
          groups: MAX_REJECTION_GROUPS,
          productIdsPerGroup: MAX_PRODUCT_IDS_PER_GROUP,
        });
        const groupsCut = result.totalGroups > result.groups.length;
        return {
          output: {
            total_rejected: result.totalRejected,
            ...(groupsCut
              ? { truncated: true, groups_total: result.totalGroups }
              : {}),
            groups: result.groups.map((group) => ({
              reason: group.reason,
              count: group.count,
              product_ids: group.productIds,
              ...(group.productTotal > group.productIds.length
                ? {
                    product_ids_truncated: true,
                    product_ids_total: group.productTotal,
                  }
                : {}),
              order_ids: group.orderIds,
            })),
          },
          evidence: result.groups.flatMap((group) =>
            group.orderIds.map((orderId) => ({ orderId, eventIds: [] })),
          ),
        };
      },
    ),
  ];
}
