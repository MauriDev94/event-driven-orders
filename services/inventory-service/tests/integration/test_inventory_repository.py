"""Integration tests for the InventoryRepository + UnitOfWork against real Postgres.

SQLite is intentionally NOT used: these tests verify row-level locking and
atomic conditional UPDATEs (``available_quantity >= qty``), which SQLite does
not support. All tests run against the Postgres instance provided by the
``pg_engine`` / ``session_factory`` fixtures in conftest.py (testcontainers
locally, GitHub Actions service container in CI).
"""

import asyncio

import pytest
from sqlalchemy import select

from app.features.inventory.application.contracts.inventory_repository import ReservationItem
from app.features.inventory.infrastructure.models.product_model import ProductModel

pytestmark = pytest.mark.integration


def _stock(session_factory, sku: str) -> int:
    session = session_factory()
    try:
        return session.execute(
            select(ProductModel.available_quantity).where(ProductModel.sku == sku)
        ).scalar_one()
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Idempotency guard
# ---------------------------------------------------------------------------


def test_should_register_event_first_time(uow_factory) -> None:
    with uow_factory() as uow:
        result = uow.inventory.register_event("evt-1")
        uow.commit()

    assert result is True


def test_should_detect_duplicate_event(uow_factory) -> None:
    with uow_factory() as uow:
        uow.inventory.register_event("evt-dup")
        uow.commit()

    with uow_factory() as uow:
        result = uow.inventory.register_event("evt-dup")
        uow.commit()

    assert result is False


# ---------------------------------------------------------------------------
# Reservation — happy path
# ---------------------------------------------------------------------------


def test_should_decrement_all_lines_when_stock_is_enough(
    uow_factory, seed_products, session_factory
) -> None:
    seed_products({"SKU-A": 5, "SKU-B": 3})

    with uow_factory() as uow:
        failed = uow.inventory.reserve_all(
            [ReservationItem("SKU-A", 2), ReservationItem("SKU-B", 1)]
        )
        uow.commit()

    assert failed is None
    assert _stock(session_factory, "SKU-A") == 3
    assert _stock(session_factory, "SKU-B") == 2


# ---------------------------------------------------------------------------
# Reservation — rejection / rollback
# ---------------------------------------------------------------------------


def test_should_reserve_nothing_when_one_line_is_short(
    uow_factory, seed_products, session_factory
) -> None:
    """All-or-nothing: SKU-A would succeed, SKU-B is short → neither decrements."""
    seed_products({"SKU-A": 5, "SKU-B": 1})

    with uow_factory() as uow:
        failed = uow.inventory.reserve_all(
            [ReservationItem("SKU-A", 2), ReservationItem("SKU-B", 4)]
        )
        uow.commit()

    assert failed == "SKU-B"
    assert _stock(session_factory, "SKU-A") == 5  # NOT decremented
    assert _stock(session_factory, "SKU-B") == 1


def test_should_not_oversell_when_quantity_exceeds_available(
    uow_factory, seed_products, session_factory
) -> None:
    seed_products({"SKU-A": 2})

    with uow_factory() as uow:
        failed = uow.inventory.reserve_all([ReservationItem("SKU-A", 3)])
        uow.commit()

    assert failed == "SKU-A"
    assert _stock(session_factory, "SKU-A") == 2


def test_should_fail_when_sku_is_unknown(uow_factory, seed_products) -> None:
    seed_products({"SKU-A": 5})

    with uow_factory() as uow:
        failed = uow.inventory.reserve_all([ReservationItem("SKU-UNKNOWN", 1)])
        uow.commit()

    assert failed == "SKU-UNKNOWN"


# ---------------------------------------------------------------------------
# Concurrency / race-condition test
#
# This is the most important test of Phase 2. Two coroutines fire concurrent
# reservations for the same SKU with exactly enough stock for ONE of them.
# The Postgres conditional UPDATE (available_quantity >= qty) + row-level
# locking guarantees that exactly one succeeds and the other is rejected —
# no oversell, ever, regardless of scheduling order.
#
# How it works: asyncio.gather starts both coroutines "simultaneously". Each
# opens its own Unit of Work (separate DB connection / transaction). Postgres
# serializes the conflicting UPDATEs at the row level: the winner commits a
# decrement; the loser's UPDATE returns rowcount == 0 (the WHERE clause fails
# because the stock is now 0).
#
# NOTE: this test cannot pass against SQLite (no FOR UPDATE / row-level
# locking). It requires the real Postgres provided by conftest.py.
# ---------------------------------------------------------------------------


async def _try_reserve(uow_factory, event_id: str) -> str | None:
    """Return None if reservation succeeded, or the failing SKU."""
    with uow_factory() as uow:
        uow.inventory.register_event(event_id)
        failed = uow.inventory.reserve_all([ReservationItem("SKU-RACE", 3)])
        uow.commit()
    return failed


async def test_should_not_oversell_under_concurrent_reservations(
    uow_factory, seed_products, session_factory
) -> None:
    """Only one of two concurrent reservations for 3 units (stock=3) can win."""
    seed_products({"SKU-RACE": 3})

    results = await asyncio.gather(
        _try_reserve(uow_factory, "evt-concurrent-1"),
        _try_reserve(uow_factory, "evt-concurrent-2"),
    )

    # Exactly one must succeed (None) and one must fail (returns sku).
    successes = [r for r in results if r is None]
    failures = [r for r in results if r is not None]

    assert len(successes) == 1, f"Expected exactly 1 success, got: {results}"
    assert len(failures) == 1, f"Expected exactly 1 failure, got: {results}"
    assert failures[0] == "SKU-RACE"

    # The stock is exactly 0 — no oversell.
    assert _stock(session_factory, "SKU-RACE") == 0
