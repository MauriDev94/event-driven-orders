"""Unit tests for the in-memory event-id deduplicator.

notification-service has no database (Phase 4 design), so the idempotency
guard used by order/inventory (a ``processed_events`` table) isn't available
here. Phase 5 adds an in-memory, bounded, FIFO-eviction set of seen
``event_id`` values to mitigate the duplicate emails that retries make more
likely. Limitation (documented in the README): a process restart clears the
set, so a redelivery after a restart can still send a duplicate email — the
DB-backed approach was rejected to avoid adding persistence to a
deliberately stateless service.
"""

import pytest

from app.features.notifications.infrastructure.dedup.in_memory_event_deduplicator import (
    InMemoryEventDeduplicator,
)

pytestmark = pytest.mark.unit


def test_should_not_be_seen_before_marking() -> None:
    dedup = InMemoryEventDeduplicator()

    assert dedup.seen("evt-1") is False


def test_should_be_seen_after_marking() -> None:
    dedup = InMemoryEventDeduplicator()

    dedup.mark_seen("evt-1")

    assert dedup.seen("evt-1") is True


def test_should_evict_oldest_entry_once_max_size_exceeded() -> None:
    dedup = InMemoryEventDeduplicator(max_size=2)

    dedup.mark_seen("evt-1")
    dedup.mark_seen("evt-2")
    dedup.mark_seen("evt-3")

    assert dedup.seen("evt-1") is False
    assert dedup.seen("evt-2") is True
    assert dedup.seen("evt-3") is True
