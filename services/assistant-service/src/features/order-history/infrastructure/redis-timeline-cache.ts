import { Logger } from '@nestjs/common';
import type { RedisConnection } from '../../../core/cache/redis.connection.js';
import type {
  EventLogEntry,
  OrderTimeline,
} from '../application/contracts/order-history.repository.js';
import { TimelineCache } from '../application/contracts/timeline-cache.js';
import { OrderView, type OrderViewState } from '../domain/order-view.js';

export interface RedisTimelineCacheOptions {
  ttlSeconds?: number;
}

interface Entry {
  /** The order's invalidation count when the timeline was read. */
  generation: string;
  timeline: { view: OrderViewState; events: EventLogEntry[] };
}

/**
 * Cache-aside for the timeline, invalidated by the order's events.
 *
 * Plain delete-on-write has a race: a read loads the old state from
 * Postgres, an event commits and deletes the key, and then the read stores
 * the old state for a whole TTL. So each order has a generation counter that
 * every invalidation increments; a read stores the generation it saw before
 * loading, and an entry whose generation is no longer current is a miss.
 *
 * Any Redis failure falls back to the database (fail open): the TTL bounds
 * how stale an entry can get if an invalidation is lost.
 */
export class RedisTimelineCache extends TimelineCache {
  private readonly logger = new Logger(RedisTimelineCache.name);
  private readonly ttlSeconds: number;
  /** Outlives every entry stored under it, so a reset can't match one. */
  private readonly generationTtlSeconds: number;

  constructor(
    private readonly redis: RedisConnection,
    options: RedisTimelineCacheOptions = {},
  ) {
    super();
    this.ttlSeconds = options.ttlSeconds ?? 60;
    this.generationTtlSeconds = this.ttlSeconds * 10;
  }

  async getOrLoad(
    orderId: string,
    load: () => Promise<OrderTimeline | null>,
  ): Promise<OrderTimeline | null> {
    const { entryKey, generationKey } = keys(orderId);
    let generation: string;
    try {
      const [cached, current] = await this.redis.client.mGet([
        entryKey,
        generationKey,
      ]);
      generation = current ?? '0';
      if (cached) {
        const entry = JSON.parse(cached) as Entry;
        if (entry.generation === generation) return restore(entry);
      }
    } catch (error) {
      this.warn('read', error);
      return load();
    }

    const timeline = await load();
    if (timeline !== null) {
      const entry: Entry = {
        generation,
        timeline: { view: timeline.view.toState(), events: timeline.events },
      };
      try {
        await this.redis.client.set(entryKey, JSON.stringify(entry), {
          EX: this.ttlSeconds,
        });
      } catch (error) {
        this.warn('write', error);
      }
    }
    return timeline;
  }

  async invalidate(orderId: string): Promise<void> {
    const { entryKey, generationKey } = keys(orderId);
    try {
      await this.redis.client
        .multi()
        .incr(generationKey)
        .expire(generationKey, this.generationTtlSeconds)
        .del(entryKey)
        .exec();
    } catch (error) {
      this.warn('invalidation', error);
    }
  }

  private warn(operation: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`timeline cache ${operation} failed: ${reason}`);
  }
}

function keys(orderId: string) {
  return {
    entryKey: `order-timeline:${orderId}`,
    generationKey: `order-timeline:${orderId}:generation`,
  };
}

/** JSON turned the dates into strings; give them back their type. */
function restore({ timeline }: Entry): OrderTimeline {
  const { view, events } = timeline;
  return {
    view: OrderView.restore({
      ...view,
      createdAt: view.createdAt === null ? null : new Date(view.createdAt),
      lastEventAt:
        view.lastEventAt === null ? null : new Date(view.lastEventAt),
    }),
    events: events.map((event) => ({
      ...event,
      occurredAt: new Date(event.occurredAt),
    })),
  };
}
