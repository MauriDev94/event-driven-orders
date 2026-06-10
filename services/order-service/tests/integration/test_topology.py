"""Integration test for the order-service broker topology declaration.

Uses an AsyncMock channel — no real RabbitMQ (same pattern as the
notification-service topology test). Verifies:

- The main queue still binds to both inventory-result routing keys.
- The main queue dead-letters (via the default exchange) straight to its DLQ
  — fixing the Phase 1-4 bug where ``x-dead-letter-exchange`` pointed at
  ``orders.dlx`` with no binding, silently dropping dead-lettered messages.
- Three retry queues are declared with escalating TTLs, each dead-lettering
  back to the main queue via the default exchange.
"""

from unittest.mock import AsyncMock

import pytest
from shared.messaging.retry_policy import RETRY_STAGES

from app.core.messaging.topology import (
    ORDER_RESULTS_DLQ,
    ORDER_RESULTS_QUEUE,
    ROUTING_STOCK_REJECTED,
    ROUTING_STOCK_RESERVED,
    declare_topology,
)

pytestmark = pytest.mark.integration


async def test_should_bind_main_queue_to_both_inventory_result_routing_keys() -> None:
    channel = AsyncMock()
    queue = AsyncMock()
    channel.declare_queue.return_value = queue

    await declare_topology(channel)

    bound_keys = {c.kwargs["routing_key"] for c in queue.bind.call_args_list}
    assert ROUTING_STOCK_RESERVED in bound_keys
    assert ROUTING_STOCK_REJECTED in bound_keys


async def test_should_dead_letter_main_queue_to_its_dlq_via_default_exchange() -> None:
    channel = AsyncMock()
    channel.declare_queue.return_value = AsyncMock()

    await declare_topology(channel)

    queue_call = next(
        c for c in channel.declare_queue.call_args_list if c.args[0] == ORDER_RESULTS_QUEUE
    )
    arguments = queue_call.kwargs["arguments"]
    assert arguments["x-dead-letter-exchange"] == ""
    assert arguments["x-dead-letter-routing-key"] == ORDER_RESULTS_DLQ


async def test_should_declare_dlq_queue() -> None:
    channel = AsyncMock()
    channel.declare_queue.return_value = AsyncMock()

    await declare_topology(channel)

    declared_names = {c.args[0] for c in channel.declare_queue.call_args_list}
    assert ORDER_RESULTS_DLQ in declared_names


async def test_should_declare_a_retry_queue_per_backoff_stage_with_escalating_ttl() -> None:
    channel = AsyncMock()
    channel.declare_queue.return_value = AsyncMock()

    await declare_topology(channel)

    for suffix, ttl_ms in RETRY_STAGES:
        retry_queue_name = f"{ORDER_RESULTS_QUEUE}.{suffix}"
        retry_call = next(
            c for c in channel.declare_queue.call_args_list if c.args[0] == retry_queue_name
        )
        arguments = retry_call.kwargs["arguments"]
        assert arguments["x-message-ttl"] == ttl_ms
        assert arguments["x-dead-letter-exchange"] == ""
        assert arguments["x-dead-letter-routing-key"] == ORDER_RESULTS_QUEUE


async def test_retry_queues_are_not_bound_to_the_topic_exchange() -> None:
    """Retry queues are only ever reached via the default exchange (by the
    retry dispatcher publishing directly to them) — they must not receive
    live traffic from the topic exchange."""
    channel = AsyncMock()
    queue = AsyncMock()
    channel.declare_queue.return_value = queue

    await declare_topology(channel)

    bound_keys = {c.kwargs.get("routing_key") for c in queue.bind.call_args_list}
    for suffix, _ in RETRY_STAGES:
        assert f"{ORDER_RESULTS_QUEUE}.{suffix}" not in bound_keys
    assert ORDER_RESULTS_DLQ not in bound_keys
