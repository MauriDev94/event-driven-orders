# Event-Driven Orders

> Sistema de procesamiento de órdenes basado en eventos — microservicios asíncronos con **RabbitMQ**.
> Portfolio project para demostrar sistemas distribuidos, mensajería y Clean Architecture.

🚧 **Work in progress** — Fase 0 (scaffold + infraestructura).

---

## Qué es

Sistema de e-commerce dividido en **3 microservicios** que se comunican por **eventos** a través de un message broker (RabbitMQ), demostrando comunicación asíncrona, idempotencia, dead-letter queues y eventual consistency.

```
   [Cliente]
       │ POST /orders
       ▼
┌──────────────┐   OrderCreated     ┌──────────────────┐
│ order-service│ ──────────────────▶│ inventory-service│
│  (FastAPI)   │◀────────────────── │  reserva stock   │
└──────┬───────┘  StockReserved/    └──────────────────┘
       │          StockRejected
       │ OrderConfirmed / OrderRejected
       ▼
┌────────────────────┐
│ notification-service│  envía email (Mailhog)
└────────────────────┘
```

## Servicios

| Servicio | Tipo | Responsabilidad |
|---|---|---|
| `order-service` | FastAPI (REST + consumer) | Crea órdenes, orquesta el ciclo de vida |
| `inventory-service` | Worker (consumer) | Reserva stock con transacción atómica |
| `notification-service` | Worker (consumer) | Envía notificaciones por email |

## Stack

`Python 3.12` · `FastAPI` · `aio-pika` · `RabbitMQ` · `PostgreSQL (database-per-service)` · `Pydantic v2` · `Mailhog` · `Docker Compose` · `pytest`

## Arquitectura

Cada servicio aplica **Clean Architecture + DDD** (capas `domain` / `application` / `infrastructure` / `presentation` / `di`), siguiendo el patrón del proyecto [Monolith](https://github.com/MauriDev94/Api_monolith).

- El **broker es un detalle de infraestructura**: los use cases hablan con un puerto `EventPublisher`; la implementación con `aio-pika` vive en `infrastructure/messaging/`.
- La capa **presentation** incluye tanto adapters HTTP (routers) como **consumers** de mensajería (puntos de entrada por eventos).
- Los **integration events** (contratos entre servicios) viven en `shared/contracts/`.

## Patrones demostrados

Idempotency keys · Dead-letter queues (DLQ) · Retries con backoff · Eventual consistency · Correlation IDs

> Observabilidad (OpenTelemetry + Jaeger + Prometheus/Grafana) está planificada para una fase posterior al MVP.

## Estado

- [ ] **Fase 0** — Scaffold + `docker-compose` (RabbitMQ + Postgres + Mailhog)
- [ ] Fase 1 — `order-service`: POST /orders + publica `OrderCreated`
- [ ] Fase 2 — `inventory-service`: consume, reserva stock, idempotencia
- [ ] Fase 3 — `order-service` consume resultado → confirma/rechaza
- [ ] Fase 4 — `notification-service`: consume → email
- [ ] Fase 5 — DLQ + retries con backoff
- [ ] Fase 6 — README final + tests e2e
