# ADR-0013 — Resiliencia de conexión al broker: retry en cold start + watchdog

**Estado:** Aceptada · **Fecha:** 2026-06-11 · **Ámbito:** los 3 servicios

## Contexto

`aio_pika.connect_robust()` maneja la reconexión automática **una vez que ya se conectó**. Pero con `fail_fast=True` (su default) **no reintenta el primer connect**.

La consecuencia en `docker compose up`: si RabbitMQ todavía no está listo cuando arranca un servicio, la excepción se loguea, el `lifespan` termina con `broker.is_connected == False` y **se queda así para siempre**. El contenedor está corriendo, el proceso está vivo, `/health` responde — pero el servicio nunca consume ni publica nada. La única salida era un `docker compose restart <servicio>` manual.

Es exactamente el escenario más común en un cold start: los tres servicios arrancan en paralelo con el broker.

## Decisión

### `connect_with_retry` en `shared/messaging/connection.py`

Vive junto a `RabbitMQConnection`, que hasta entonces estaba **duplicada en los tres servicios** — mismo criterio DRY que `wrap_with_retry` y la observabilidad ([ADR-0003](0003-shared-contratos-e-infraestructura-transversal.md)).

Backoff exponencial capado: `base_delay=1s`, `max_delay=30s`, duplicando en cada intento.

### Retry acotado al arranque + watchdog en background

1. El `lifespan` intenta conectar hasta `max_attempts=5` → 1+2+4+8 s ≈ **15 s**, que cubre el cold start normal de `docker compose`.
2. Si aun así no conecta, lanza una **tarea en background** (`max_attempts=None`, backoff capado a 30 s) que reintenta indefinidamente y completa la declaración de topología y el arranque del consumer **apenas el broker responde** — sin restart manual.

### Reconexión en caliente: gratis

Lograda la primera conexión, si RabbitMQ se cae y vuelve, `connect_robust` reconecta solo y re-declara exchanges, queues, bindings y consumers registrados en su `RobustChannel`. **No requiere código propio.**

### Observabilidad de la conexión

Cada intento y cada reconexión se loguea de forma estructurada (`broker connection attempt %d failed...`, `connected to broker after %d attempt(s)`) para poder operar el sistema ([ADR-0012](0012-logging-json-y-correlation-id.md)).

## Consecuencias

**Positivas**

- Un `docker compose up` en frío nunca deja un servicio zombie.
- `/health` reporta `"broker": "unhealthy"` mientras dura la caída, sin que el proceso crashee ([ADR-0014](0014-health-siempre-200.md)).
- `RabbitMQConnection` deja de estar triplicada.

**Negativas / limitaciones**

- La reconexión **real** de `connect_robust` no se testea con testcontainers: sería lento y en la práctica testearía la librería. Se verifica a mano — el procedimiento está en el [README](../../README.md#verificar-la-reconexión-al-broker).
- Lo que sí está cubierto por tests:
  - `shared/tests/test_connection.py` — retry/backoff de forma pura (connector mockeado, sin I/O): éxito al primer intento, backoff exponencial, agotamiento de `max_attempts`, retry indefinido, cap de `max_delay`, y clasificación de errores de conexión vs. no relacionados.
  - `test_lifespan_broker_reconnect.py` en cada servicio — el wiring `lifespan` → watchdog → `_start_consuming`.
