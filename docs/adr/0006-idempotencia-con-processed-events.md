# ADR-0006 — Idempotencia vía `processed_events` en la misma transacción

**Estado:** Aceptada · **Fecha:** 2026-06-09 · **Ámbito:** `order-service`, `inventory-service`

## Contexto

RabbitMQ entrega *at-least-once*. Un mismo mensaje llega dos veces por causas normales: un retry con backoff ([ADR-0011](0011-retry-con-backoff-y-dlq.md)), un `nack` con requeue, una reconexión del consumer, o un ACK que se perdió en la red.

Sin protección, un `OrderCreated` reprocesado **decrementa el stock dos veces**. Un `StockReserved` reprocesado **re-publica `OrderConfirmed`**, disparando otro email.

La solución ingenua — consultar si el `event_id` ya se procesó y, si no, procesarlo — es un *check-then-act*: dos consumers concurrentes pueden leer "no procesado" a la vez y ejecutar ambos.

## Decisión

Tabla `processed_events` con el `event_id` como clave, y el registro del evento ocurriendo **en la misma transacción que la lógica de negocio**:

```sql
INSERT INTO processed_events (event_id, ...) VALUES (:event_id, ...)
ON CONFLICT DO NOTHING
```

Si `rowcount == 0`, el evento ya se procesó → **ACK sin re-ejecutar y sin re-publicar**.

El **Unit of Work** es el contrato que hace posible la atomicidad: `register_event` y la operación de negocio (`reserve_all` en inventario, la confirmación/rechazo en órdenes) comparten la **misma sesión**, y `uow.commit()` los confirma juntos. No existe ningún instante en que el efecto de negocio esté aplicado sin su marca de idempotencia, ni al revés.

`notification-service` no tiene base de datos y resuelve esto de otra forma — ver [ADR-0009](0009-notification-service-sin-base-de-datos.md).

## Consecuencias

**Positivas**

- Los reintentos con backoff son seguros: reprocesar es un no-op.
- Atomicidad real, garantizada por la base de datos. No hay ventana de race.
- Es una sola query extra por evento.

**Negativas / limitaciones**

- `processed_events` crece indefinidamente: **no hay política de purga en el MVP**.
- La garantía depende de comportamiento específico de PostgreSQL (`ON CONFLICT`, row-level locking), lo que obliga a testear contra PostgreSQL real ([ADR-0008](0008-tests-contra-postgres-real.md)).
- Sigue existiendo la ventana de publish-after-commit ([ADR-0005](0005-publish-after-commit-en-vez-de-outbox.md)): la idempotencia protege del reproceso, no del evento que nunca se publicó.
