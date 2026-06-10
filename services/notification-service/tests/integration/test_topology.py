"""Integration test for the broker topology declaration.

Uses an AsyncMock channel — no real RabbitMQ. Verifies the order-outcomes
queue is bound to BOTH order.confirmed and order.rejected routing keys and is
configured to dead-letter, so a redelivery/failure has somewhere to go.
"""

from unittest.mock import AsyncMock

import pytest

from app.core.messaging.topology import (
    ORDER_OUTCOMES_QUEUE,
    ROUTING_ORDER_CONFIRMED,
    ROUTING_ORDER_REJECTED,
    declare_topology,
)

pytestmark = pytest.mark.integration


async def test_should_bind_queue_to_both_order_outcome_routing_keys() -> None:
    channel = AsyncMock()
    queue = AsyncMock()
    channel.declare_queue.return_value = queue

    await declare_topology(channel)

    # Queue declared with dead-letter arguments.
    queue_call = next(
        call
        for call in channel.declare_queue.call_args_list
        if call.args[0] == ORDER_OUTCOMES_QUEUE
    )
    assert queue_call.kwargs["arguments"]["x-dead-letter-exchange"]

    bound_keys = {call.kwargs["routing_key"] for call in queue.bind.call_args_list}
    assert ROUTING_ORDER_CONFIRMED in bound_keys
    assert ROUTING_ORDER_REJECTED in bound_keys
