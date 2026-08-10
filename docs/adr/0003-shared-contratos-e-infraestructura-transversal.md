# ADR-0003 — `shared/` como fuente única de contratos e infraestructura transversal

**Estado:** Aceptada · **Fecha:** 2026-06-07 · **Ámbito:** monorepo

## Contexto

En un monorepo con tres servicios hay código que forzosamente tiene que ser idéntico en los tres:

- La forma de los eventos que viajan por el broker. Si `order-service` publica un `OrderCreated` con un campo que `inventory-service` no espera, el sistema se rompe en runtime.
- La política de retry/DLQ, el formato de logging y la lógica de conexión al broker: implementarlas tres veces garantiza que diverjan.

Al mismo tiempo, compartir demasiado convierte el monorepo en un monolito distribuido: si los servicios comparten entidades de dominio, dejan de ser autónomos.

## Decisión

Existe un paquete `shared/` con un alcance estrictamente delimitado:

| Módulo | Contenido |
|---|---|
| `shared/contracts/` | **Única fuente** de los *integration events* (Pydantic): `BaseEvent` + `Order*` / `Stock*` |
| `shared/messaging/` | `retry_policy` + `retry_dispatcher` (DLQ/backoff) y `connection` (`RabbitMQConnection`, `connect_with_retry`) |
| `shared/observability/` | Logging JSON (structlog) + correlation ID vía contextvars |

Reglas:

- **Los servicios no comparten entidades de dominio.** Solo los modelos Pydantic de `shared/contracts/` cruzan el broker; cada servicio mapea entre su dominio y esos contratos.
- **`shared/` nunca contiene lógica de negocio.** Es infraestructura transversal y contratos, nada más.

## Consecuencias

**Positivas**

- Un cambio de contrato se hace y se revisa en un solo lugar.
- Retry/DLQ ([ADR-0011](0011-retry-con-backoff-y-dlq.md)), logging ([ADR-0012](0012-logging-json-y-correlation-id.md)) y conexión al broker ([ADR-0013](0013-resiliencia-de-conexion-al-broker.md)) se implementan una vez. `RabbitMQConnection` llegó a estar triplicada y se consolidó aquí.
- El dominio de cada servicio permanece privado.

**Negativas / limitaciones**

- `shared/` es un punto de acoplamiento: un cambio incompatible rompe los tres servicios a la vez. Mitigado porque solo contiene contratos e infraestructura, sin reglas de negocio.
- Obliga a que el build context sea la raíz del repo ([ADR-0015](0015-build-context-en-la-raiz.md)).
- `shared/` no está en el gate de `mypy` de CI: `quality-shared` solo corre `ruff check shared`. Se evaluó agregar `mypy` y con la configuración actual (`--ignore-missing-imports`, las mismas stubs que usan los servicios) no reporta errores; queda pendiente decidir si se suma al gate.
