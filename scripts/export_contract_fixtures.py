"""Export one JSON fixture per integration event, built from the Pydantic contracts.

assistant-service (TypeScript) parses these fixtures with its zod schemas, so a
contract changed in ``shared/contracts`` and not in
``services/assistant-service/src/core/messaging/contracts.ts`` fails its tests.
The values are fixed, so the output only changes when a contract does.

    uv run --package shared python scripts/export_contract_fixtures.py          # write
    uv run --package shared python scripts/export_contract_fixtures.py --check  # CI: fail if stale
"""

import argparse
import sys
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from shared.contracts.base_event import BaseEvent
from shared.contracts.inventory_events import StockRejected, StockReserved
from shared.contracts.order_events import (
    OrderConfirmed,
    OrderCreated,
    OrderItem,
    OrderRejected,
)

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "services" / "assistant-service" / "test" / "fixtures" / "contracts"

ORDER_ID = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a7b"
CORRELATION_ID = "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a"
CUSTOMER_ID = "c-1"
OCCURRED_AT = datetime(2026, 10, 31, 12, 0, 0, 123456, tzinfo=UTC)


def fixtures() -> list[BaseEvent]:
    common = {"correlation_id": CORRELATION_ID, "occurred_at": OCCURRED_AT}
    return [
        OrderCreated(
            event_id="e-order-created",
            order_id=ORDER_ID,
            customer_id=CUSTOMER_ID,
            items=[
                OrderItem(product_id="SKU-001", quantity=2, unit_price=Decimal("10.00")),
                OrderItem(product_id="SKU-002", quantity=1, unit_price=Decimal("5.50")),
            ],
            total_amount=Decimal("25.50"),
            **common,
        ),
        StockReserved(event_id="e-stock-reserved", order_id=ORDER_ID, **common),
        StockRejected(
            event_id="e-stock-rejected",
            order_id=ORDER_ID,
            reason="insufficient stock for product SKU-005",
            **common,
        ),
        OrderConfirmed(
            event_id="e-order-confirmed", order_id=ORDER_ID, customer_id=CUSTOMER_ID, **common
        ),
        OrderRejected(
            event_id="e-order-rejected",
            order_id=ORDER_ID,
            customer_id=CUSTOMER_ID,
            reason="insufficient stock for product SKU-005",
            **common,
        ),
    ]


def render() -> dict[str, str]:
    """File name -> content, exactly as the publishers serialize each event."""
    return {
        f"{event.event_type}.json": event.model_dump_json(indent=2) + "\n" for event in fixtures()
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail if a fixture is stale")
    args = parser.parse_args(argv)

    expected = render()
    if args.check:
        stale = [
            name
            for name, content in expected.items()
            if not (OUTPUT / name).exists()
            or (OUTPUT / name).read_text(encoding="utf-8") != content
        ]
        extra = sorted(p.name for p in OUTPUT.glob("*.json") if p.name not in expected)
        if stale or extra:
            print(
                f"Contract fixtures are stale ({', '.join(stale + extra)}). Run "
                "`uv run --package shared python scripts/export_contract_fixtures.py` and "
                "update the zod schemas in assistant-service if a contract changed.",
                file=sys.stderr,
            )
            return 1
        print("Contract fixtures are up to date.")
        return 0

    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, content in expected.items():
        (OUTPUT / name).write_text(content, encoding="utf-8", newline="\n")
    print(f"Wrote {len(expected)} fixtures to {OUTPUT.relative_to(ROOT)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
