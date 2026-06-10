"""In-memory, bounded deduplication of seen integration-event ids.

notification-service has no database (Phase 4 design), so it cannot rely on
a ``processed_events`` table like order/inventory do. This is a best-effort
mitigation for the duplicate emails that retries (Phase 5) make more likely:
within a single process lifetime, redelivering an already-handled
``event_id`` is a no-op.

Limitation: the set is cleared on restart, so a redelivery shortly after a
restart can still trigger a duplicate email. A persistent guard would require
adding a database to a service that is deliberately stateless — out of scope
for Phase 5 (documented in the README).
"""

from collections import OrderedDict


class InMemoryEventDeduplicator:
    """FIFO-bounded set of seen ``event_id`` values."""

    def __init__(self, max_size: int = 10_000) -> None:
        self._max_size = max_size
        self._seen: OrderedDict[str, None] = OrderedDict()

    def seen(self, event_id: str) -> bool:
        return event_id in self._seen

    def mark_seen(self, event_id: str) -> None:
        if event_id in self._seen:
            return
        self._seen[event_id] = None
        if len(self._seen) > self._max_size:
            self._seen.popitem(last=False)
