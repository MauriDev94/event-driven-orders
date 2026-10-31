/**
 * Business metrics with the same names and labels as the Python services'
 * `shared.observability.metrics`, so the Grafana panels include this service
 * as is. They live in prom-client's default registry, served at /metrics.
 */
import { Counter, Histogram, register } from 'prom-client';

// Test files re-evaluate this module while prom-client's registry stays the
// same, so an already registered metric is reused instead of redefined.
function counter(name: string, help: string, labelNames: string[]): Counter {
  return (
    (register.getSingleMetric(name) as Counter | undefined) ??
    new Counter({ name, help, labelNames })
  );
}

function histogram(
  name: string,
  help: string,
  labelNames: string[],
  buckets: number[],
): Histogram {
  return (
    (register.getSingleMetric(name) as Histogram | undefined) ??
    new Histogram({ name, help, labelNames, buckets })
  );
}

export const EVENTS_PROCESSED = counter(
  'edo_events_processed_total',
  'Domain events successfully processed by consumers',
  ['service', 'event_type'],
);

export const EVENTS_DLQ = counter(
  'edo_events_dlq_total',
  'Events dead-lettered after exhausting retries or on permanent failure',
  ['queue'],
);

export const EVENTS_RETRIED = counter(
  'edo_events_retried_total',
  'Retry attempts across all queues',
  ['queue'],
);

export const EVENT_PROCESSING_SECONDS = histogram(
  'edo_event_processing_seconds',
  'Handler processing latency in seconds',
  ['service'],
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5],
);
