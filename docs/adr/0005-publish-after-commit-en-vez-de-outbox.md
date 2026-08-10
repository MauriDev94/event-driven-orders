# ADR-0005 — Publish-after-commit en vez de outbox transaccional

**Estado:** Aceptada (MVP) · **Fecha:** 2026-06-08 · **Ámbito:** `order-service`, `inventory-service`

## Contexto

`CreateOrder` tiene que hacer dos cosas: persistir la orden en PostgreSQL y publicar `OrderCreated` en RabbitMQ. Son **dos sistemas distintos**: no existe una transacción que cubra a los dos. Este es el problema clásico de *dual-write*.

Hay tres caminos:

1. **Publicar antes de commitear**: si el commit falla, se emitió un evento sobre una orden que no existe. Los consumers reaccionan a algo fantasma. Es el peor caso.
2. **Publicar después de commitear**: si la publicación falla, la orden existe pero nadie se entera.
3. **Outbox transaccional**: escribir el evento en una tabla `outbox` dentro de la misma transacción que la orden, y que un proceso relay lo publique y lo marque como enviado. Correcto, pero exige tabla, relay, deduplicación y operación adicional.

## Decisión

El use case **persiste y commitea primero, y publica después**. Se acepta explícitamente la ventana de dual-write. El outbox transaccional queda **fuera del alcance del MVP**.

El mismo patrón se repite en `inventory-service` (reserva de stock y publicación de `StockReserved`/`StockRejected`) y en la confirmación/rechazo de órdenes.

## Consecuencias

**Positivas**

- Implementación simple: sin tabla `outbox`, sin proceso relay, sin operación extra.
- El peor escenario (evento sobre una orden inexistente) queda descartado: si hay evento, el estado ya está commiteado.

**Negativas / limitaciones**

- **Ventana de dual-write**: si la publicación falla después del commit, la orden queda en `pending` para siempre — ni confirmada ni rechazada — y nadie la reintenta.
- La limitación se repite en los tres puntos donde se publica tras commitear.
- La recuperación es manual: no hay reconciliación automática de órdenes huérfanas.

## Alternativas

**Outbox transaccional.** Es el endurecimiento natural y está listado en *Mejoras futuras* del [README](../../README.md#mejoras-futuras-post-mvp). Elimina la ventana por completo a costa de una tabla, un relay y la deduplicación en el lado del publisher.
