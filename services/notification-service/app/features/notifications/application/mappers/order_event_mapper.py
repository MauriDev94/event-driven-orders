"""Map order-outcome integration events to SendOrderNotification params.

This lives in the application layer: translating an inbound integration event
into use-case input is an application concern. The use case stays free of the
wire contract.

The events carry ``customer_id``, not an email address. The MVP has no customer
directory service, so we derive a deterministic placeholder recipient from the
id. Wiring a real lookup is out of scope for Phase 4 (documented in README).
"""

from shared.contracts.order_events import OrderConfirmed, OrderRejected

from app.features.notifications.application.usecases.send_order_notification_use_case import (
    CONFIRMED,
    REJECTED,
    SendOrderNotificationParams,
)

_EMAIL_DOMAIN = "example.com"


def _derive_email(customer_id: str) -> str:
    """Derive a placeholder recipient address from the customer id.

    MVP limitation: there is no customer directory, so we cannot resolve a real
    inbox. Deterministic so the same customer always maps to the same address.
    """
    return f"{customer_id}@{_EMAIL_DOMAIN}"


def map_order_confirmed_to_params(event: OrderConfirmed) -> SendOrderNotificationParams:
    return SendOrderNotificationParams(
        order_id=event.order_id,
        customer_email=_derive_email(event.customer_id),
        outcome=CONFIRMED,
    )


def map_order_rejected_to_params(event: OrderRejected) -> SendOrderNotificationParams:
    return SendOrderNotificationParams(
        order_id=event.order_id,
        customer_email=_derive_email(event.customer_id),
        outcome=REJECTED,
        reason=event.reason,
    )
