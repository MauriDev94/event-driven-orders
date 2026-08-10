# ADR-0012 — Logging JSON estructurado + correlation ID end-to-end

**Estado:** Aceptada · **Fecha:** 2026-06-11 · **Ámbito:** los 3 servicios

## Contexto

Una orden atraviesa tres servicios de forma asíncrona ([ADR-0001](0001-comunicacion-asincrona-por-eventos.md)). Cuando algo sale mal, la pregunta es siempre la misma: *¿qué pasó con la orden X?*

Con logging de texto plano y sin identificador común, responderla significa leer tres streams de logs, en tres contenedores, sin nada que los una. El `order_id` a veces aparece y a veces no, y las librerías (`uvicorn`, `aio-pika`) escriben en su propio formato.

## Decisión

### Logging JSON centralizado en `shared/observability/`

`configure_logging(service_name)` configura **structlog y el `logging` estándar** para que **toda** línea — propia o de librerías — salga como JSON con `timestamp`, `level`, `logger`, `event`, `service` y los campos contextuales.

Se mantienen dos cadenas de procesadores (la de structlog y la `foreign_pre_chain` para el `logging` estándar) que terminan en el **mismo `JSONRenderer`**.

```json
{"timestamp": "2026-06-10T12:00:00Z", "level": "info", "logger": "app.core.middleware.correlation_id",
 "event": "request completed", "service": "order-service", "correlation_id": "a1b2c3d4-...",
 "method": "POST", "path": "/v1/orders", "status_code": 201, "duration_ms": 12.4}
```

### Correlation ID vía `structlog.contextvars`

`shared/observability/context.py` expone `bound_correlation_id(id)` y `get_correlation_id()`. Mientras el contexto está bindeado, el processor `merge_contextvars` inyecta `correlation_id` en **cada** línea, sin que ningún `log.info(...)` tenga que pasarlo a mano.

### Entrada HTTP

Middleware en `order-service`: lee `X-Correlation-ID` del request (o genera un `uuid4()`), lo bindea durante todo el request, emite `"request completed"` con `method` / `path` / `status_code` / `duration_ms`, y devuelve el id en el header de la respuesta.

### Propagación por el broker

`BaseEvent.correlation_id` viaja en cada evento. En el lado publisher, `map_order_to_order_created` hace `correlation_id = get_correlation_id() or order.id`. En el lado consumer, **`wrap_with_retry` extrae el `correlation_id` del body y lo bindea durante el dispatch** — un único punto de integración que cubre los tres consumers ([ADR-0011](0011-retry-con-backoff-y-dlq.md)).

> **Separación clave:** `order.id` es identidad de **negocio** (estable, del dominio). `correlation_id` es identidad de **traza** (por request o cadena de eventos). No son lo mismo, aunque el fallback los iguale cuando no hay request HTTP de origen.

## Consecuencias

**Positivas**

- `jq -c 'select(.correlation_id == "<id>")'` sobre los logs combinados traza una orden por los tres servicios.
- El instrumento de retry es el único lugar que bindea en consumers: cero código repetido en los tres servicios.
- Es la base lista para tracing distribuido (OpenTelemetry, en *Mejoras futuras*).
- El cliente puede enviar su propio `X-Correlation-ID` y correlacionar desde su lado.

**Negativas / limitaciones**

- Los logs JSON son incómodos de leer a ojo sin `jq`.
- Configurar logging es un **efecto secundario global**: no admite TDD clásico. Se cubrió con tests de comportamiento usando `structlog.testing.LogCapture`.

> **Gotcha:** *no* usar `capture_logs()` para estos tests. En structlog 26.x reemplaza toda la cadena de procesadores y descarta `merge_contextvars`, con lo que el `correlation_id` se vuelve invisible y el test pasa sin verificar nada.
