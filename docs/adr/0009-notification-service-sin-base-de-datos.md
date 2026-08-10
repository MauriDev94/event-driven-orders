# ADR-0009 — `notification-service` sin base de datos: deduplicación en memoria

**Estado:** Aceptada (MVP) · **Fecha:** 2026-06-09 · **Ámbito:** `notification-service`

## Contexto

`notification-service` es un consumer puro: recibe `OrderConfirmed` / `OrderRejected` y habla con un servidor SMTP. No persiste nada de negocio.

Pero RabbitMQ es *at-least-once* ([ADR-0001](0001-comunicacion-asincrona-por-eventos.md)), así que un redelivery **reenvía el mismo email**. La solución consistente con el resto del sistema sería la tabla `processed_events` ([ADR-0006](0006-idempotencia-con-processed-events.md)) — pero eso significa agregar un tercer PostgreSQL al stack **solo** para deduplicar.

## Decisión

`notification-service` **no tiene base de datos**. La deduplicación se hace con `InMemoryEventDeduplicator`: un set acotado, con desalojo FIFO, de los `event_id` ya vistos.

El criterio para aceptar la limitación: **un email duplicado es molesto, no corrompe estado de negocio.** No hay stock mal descontado ni órdenes en un estado inválido.

## Consecuencias

**Positivas**

- Un contenedor menos y un esquema menos que mantener.
- Cubre el caso frecuente: el redelivery inmediato por retry o `nack` ([ADR-0011](0011-retry-con-backoff-y-dlq.md)).
- El servicio arranca sin esperar migraciones.

**Negativas / limitaciones**

- **No sobrevive reinicios del proceso**: tras un restart puede reenviarse un email ya enviado.
- El set es **acotado**: un redelivery muy tardío cae fuera de la ventana y pasa como evento nuevo.
- Con varias réplicas del servicio, cada una tiene su propio set: un evento visto por la réplica A no está deduplicado en la B.

Todas se aceptan para el MVP. La idempotencia persistente con `processed_events` está listada en *Mejoras futuras* del [README](../../README.md#mejoras-futuras-post-mvp).
