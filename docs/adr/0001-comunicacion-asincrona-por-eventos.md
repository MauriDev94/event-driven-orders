# ADR-0001 — Comunicación exclusiva por eventos y eventual consistency

**Estado:** Aceptada · **Fecha:** 2026-06-07 · **Ámbito:** los 3 servicios

## Contexto

El flujo de negocio (crear una orden) atraviesa tres responsabilidades separadas: registrar la orden, reservar stock y notificar al cliente. Hay dos formas de integrarlas:

1. **Llamadas HTTP síncronas** entre servicios, con una transacción distribuida (2PC) o una saga orquestada sobre HTTP.
2. **Eventos** publicados en un message broker, con consistencia eventual.

La opción 1 acopla la disponibilidad de los tres servicios: si `inventory-service` está caído, `order-service` no puede aceptar órdenes. Además, 2PC sobre servicios con bases de datos independientes es caro y frágil.

## Decisión

Los servicios se comunican **exclusivamente por eventos** a través de RabbitMQ. Ningún servicio llama a otro por HTTP.

El ciclo de vida de una orden es asíncrono:

```
order.created ─▶ stock.reserved | stock.rejected ─▶ order.confirmed | order.rejected
```

`POST /v1/orders` responde `201` con la orden en estado `pending`. El estado final se consulta con `GET /v1/orders/{id}`.

## Consecuencias

**Positivas**

- Desacoplamiento temporal: `inventory-service` puede estar caído y `order-service` sigue aceptando órdenes; se procesan cuando vuelve.
- Sin transacción distribuida ni 2PC.
- Cada servicio escala de forma independiente.

**Negativas / limitaciones**

- **Consistencia eventual**: el cliente recibe `pending` y debe hacer polling. No hay un momento en que "la orden esté confirmada" de forma síncrona.
- RabbitMQ entrega *at-least-once*: cada consumer tiene que ser idempotente ([ADR-0006](0006-idempotencia-con-processed-events.md), [ADR-0009](0009-notification-service-sin-base-de-datos.md)).
- Depurar un flujo distribuido asíncrono es más difícil que seguir un stack trace. Esto motiva el correlation ID end-to-end ([ADR-0012](0012-logging-json-y-correlation-id.md)).
- Los tests que ejercitan el flujo completo requieren polling con timeout, no aserciones inmediatas.
