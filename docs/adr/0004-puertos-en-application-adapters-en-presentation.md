# ADR-0004 — Puertos en `application/`, adapters en `presentation/` e `infrastructure/`

**Estado:** Aceptada · **Fecha:** 2026-06-07 · **Ámbito:** los 3 servicios

## Contexto

Los tres servicios aplican Clean Architecture + DDD con capas `domain` / `application` / `infrastructure` / `presentation` / `di`, siguiendo el patrón del proyecto [Monolith](https://github.com/MauriDev94/Api_monolith). Falta definir con precisión dónde vive cada pieza cuando aparecen dos entradas distintas (HTTP y eventos) y dos salidas de I/O (broker y SMTP).

## Decisión

**Todo I/O externo entra por un puerto declarado en `application/contracts/`.**

| Puerto | Implementación |
|---|---|
| `EventPublisher` | `infrastructure/messaging/` (aio-pika) |
| `EmailSender` | `infrastructure/email/` (`SmtpEmailSender`) |

Los use cases nunca importan `aio_pika` ni `smtplib`: **el broker y el servidor SMTP son detalles de infraestructura.**

**`presentation/` = puntos de entrada (adapters).**

- `order-service`: `presentation/http/` (routers + schemas) y `presentation/consumers/` (handlers de eventos).
- Workers (`inventory-service`, `notification-service`): solo `presentation/consumers/`.

**Los consumers son adapters puros.** `build_*_handler(use_case)` es una factory que deserializa el mensaje, hace el dispatch por `event_type` cuando corresponde, construye los params, invoca el use case y ACKea. **Cero lógica de negocio en el consumer.** Un `event_type` desconocido produce NACK sin requeue (dead-letter).

**El use case retorna la entidad de dominio.** El endpoint la mapea a `OrderResponse` con un mapper de presentación (Domain Entity → Response Schema). La entidad de dominio nunca se expone directamente como respuesta HTTP.

**`AsyncUseCase` separada de `UseCase`.** `EventPublisher.publish` es `async`, así que `CreateOrder.execute` tiene que poder hacer `await`. Se definió una base `AsyncUseCase` distinta de la `UseCase` síncrona (la que usa `GetOrder`) para que el límite sync/async sea explícito **a nivel de tipos**, y no algo que se descubre leyendo la implementación.

Las rutas HTTP están versionadas: `/v1/orders`.

## Consecuencias

**Positivas**

- Los use cases se testean sin broker ni servidor SMTP, usando dobles del puerto.
- Cambiar RabbitMQ o el proveedor de email no toca `application/` ni `domain/`.
- El dominio nunca filtra al exterior: ni por HTTP ni por el broker ([ADR-0003](0003-shared-contratos-e-infraestructura-transversal.md)).
- El mismo use case sirve a una entrada HTTP y a una entrada por eventos sin cambios.

**Negativas / limitaciones**

- Más indirección: cada I/O externo necesita puerto + implementación + wiring en `di/`.
- Dos jerarquías de use case (`UseCase` / `AsyncUseCase`) que hay que elegir correctamente al crear uno nuevo.
