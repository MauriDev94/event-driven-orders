# Roadmap

Estado al **2026-10-28**: el MVP está completo (fases F0–F9 y el hardening posterior, hasta el PR #40). Este documento junta los pendientes y hallazgos de la revisión del 2026-10-28 y el orden propuesto para seguir. Las decisiones de cada paso se registran como ADR en [`docs/adr/`](adr/README.md) cuando corresponda; el detalle de cada tarea va en su issue.

## Paso 0 — Entorno de desarrollo en el equipo actual

- [x] El `.venv/` lo gestiona uv nativo de Windows con Docker Desktop ([ADR-0020](adr/0020-venv-nativo-con-docker-desktop.md), reemplaza a ADR-0019, cuyas rutas eran del equipo anterior).
- [x] `.python-version` fija 3.12, igual que CI y los Dockerfiles.
- [x] Se eliminó `.wsl-smoke-test.py`, y los tests de `shared/tests/integration/` ya no hablan de WSL.
- [x] Se eliminó `odd/`, que venía del flujo de trabajo del equipo anterior. Lo que valía la pena conservar del task doc y del runbook de los forcing tests (escenarios, comandos, tiempos, el workaround del readiness probe) quedó en el README (sección Testing), en los docstrings de `shared/tests/integration/` y en el paso 1 de este roadmap.
- [x] Verificado en este equipo: `uv sync --all-packages --frozen`, `uv lock --check`, ruff + format + mypy en los 3 servicios y `shared/`, testcontainers con Postgres y RabbitMQ.
- [x] **Bug: el shutdown se cuelga si el broker está caído** (bloquea las suites de integración en Windows). Issue [#43](https://github.com/MauriDev94/event-driven-orders/issues/43). `RabbitMQConnection.connect()` llama a `aio_pika.connect_robust(...)` y, si el intento inicial falla o se cancela, no cierra la `RobustConnection` (ni siquiera guarda la referencia). Su tarea interna `__connection_factory` (aio-pika 9.6.2) captura `asyncio.CancelledError` y sigue reconectando mientras la conexión no esté cerrada (`_close_called`), así que `asyncio.run` espera para siempre en `_cancel_all_tasks`. En Windows pasa casi siempre: la conexión rechazada tarda ~2 s y la cancelación cae en medio del intento. En Linux es una carrera poco frecuente, pero en producción un `docker compose stop` durante una caída de RabbitMQ puede terminar en SIGKILL. Arreglo: `connect()` crea la `RobustConnection` explícitamente y llama a `close()` si el intento lanza cualquier excepción, incluida la cancelación. Cubierto por `shared/tests/test_connection_shutdown.py` (un servidor TCP local que nunca responde el handshake, sin Docker).
- [x] **Tests lentos.** Los tests que arrancaban el lifespan real sin broker (fixtures `client` / `api_client`) pasaban por `connect_with_retry`: 5 intentos con backoff de 1+2+4+8 s, y en Windows cada intento contra `localhost` tarda ~4 s (`::1` y `127.0.0.1`), ~35 s por arranque. Ahora esos fixtures reemplazan `app.main.connect_with_retry` por un doble que falla al primer intento y deja el watchdog esperando hasta el shutdown. De paso, ya no se conectan a un RabbitMQ local si hay uno corriendo (`make up`). Issue [#43](https://github.com/MauriDev94/event-driven-orders/issues/43). La suite de `order-service` bajó de 9 min 19 s a 28 s en Windows.
- [ ] **El mismo problema con la base en `/health`**: los tests que llaman a `/health` en `order-service` e `inventory-service` ejecutan el `SELECT 1` contra la base configurada (`localhost:5432`), no contra la del testcontainer. En Windows tardan ~4 s cada uno por la conexión rechazada, y con `make up` corriendo se conectan a la base del stack. Reemplazar la sesión de `/health` en el fixture `client`.
- [ ] `make` en Windows: instalar con `winget install ezwinports.make` (opcional; mientras tanto, los comandos `uv` equivalentes están en `CLAUDE.md`).
- [ ] Levantar el stack completo (`make up`) y correr `make e2e` en este equipo.

## Paso 1 — Cerrar lo suelto

- [ ] **Issue #37**: sigue abierto, pero el PR #38 ya hizo la migración a uv workspaces. Cerrarlo.
- [ ] **Issue #36** (panel "RabbitMQ Queue Depth" con una sola serie): el plugin `rabbitmq_prometheus` entrega métricas agregadas en `/metrics`. Para series por cola, scrapear `/metrics/per-object` (o `/metrics/detailed`) o activar `prometheus.return_per_object_metrics = true`. Verificar contra la versión de RabbitMQ del compose.
- [ ] **Los tests de `shared` no corren en CI**: el job `quality-shared` solo pasa ruff. Agregar un job de tests de `shared` (unit, `-m "not integration"`) y el job `tests-broker` pendiente del issue #39 (`-m "integration and not slow"`, solo el escenario rápido en cada PR). Los dos escenarios `slow` (~4 min de TTLs reales) quedan para pushes a `main` o un workflow manual (`workflow_dispatch`).
- [ ] **`mypy` no corre sobre `shared/`** (ni en `make lint` ni en CI) y tiene 2 errores de tipos: `RabbitMQConnection.connect()` asigna el `AbstractChannel` que devuelve `await connection.channel()` a un atributo tipado `AbstractRobustChannel`, y `retry_dispatcher.py` pasa un header AMQP sin acotar a `int()`. Arreglarlos y sumar `mypy src` al lint de `shared`.
- [ ] **`make test` corre los forcing tests lentos de `shared`** (~4,5 min, requieren Docker): el target llama a `pytest` sin filtro de markers y `shared/pyproject.toml` no tiene `addopts`. El task doc del PR #40 decía que se excluían por defecto, pero no es así. Agregar `-m "not integration"` al target (y un target aparte para los forcing tests).
- [ ] **README desactualizado**: dice que CI usa caché de `pip` (es uv) y que el gate de `inventory-service` es 40 (es 80); la tabla de tests y cobertura también puede estar atrasada. El comentario del job `tests-db` en `ci.yml` repite el "fail_under = 40", y el de `[tool.coverage.report]` en `services/order-service/pyproject.toml` todavía habla de un override de SQLite.
- [ ] **Secretos versionados**, que chocan con la regla del workspace (GitGuardian): contraseñas no vacías en `.env.example` (RabbitMQ y las dos bases), la contraseña de admin de Grafana fija en `docker-compose.yml`, y el valor de respaldo de la contraseña de Postgres en `ci.yml` (`tests-db`). Pasarlos a variables sin valor por defecto (o generadas en runtime en CI).

## Paso 2 — Evidencia: carga y deploy

- [ ] **Prueba de carga** (k6 o Locust): cientos de órdenes concurrentes sobre el mismo SKU, para mostrar que no hay sobreventa ([ADR-0007](adr/0007-reserva-de-stock-atomica.md)) y sacar el screenshot del dashboard de Grafana con tráfico real.
- [ ] **Fase 8c: deploy real** en Oracle Cloud con `docker-compose.prod.yml` + Caddy. Completar el TODO del screenshot en el README.

## Paso 3 — Outbox transaccional

- [ ] Reemplazar publish-after-commit ([ADR-0005](adr/0005-publish-after-commit-en-vez-de-outbox.md)) por una tabla `outbox` escrita en la misma transacción y un relay que publique y marque. Es requisito antes de mover plata (paso 4). Nuevo ADR que reemplace al 0005.

## Paso 4 — Pagos con saga

- [ ] **Prerrequisito: el precio sale del catálogo, no del cliente.** Hoy `unit_price` llega en el body de `POST /v1/orders` y se acepta `0` (`OrderLineRequest`, `Field(ge=0)`).
- [ ] **`payment-service`** con la saga y su compensación:

  ```
  order.created → stock.reserved → payment.requested ─┬→ payment.succeeded → order.confirmed
                                                      └→ payment.failed → stock.released (compensación) → order.rejected
  ```

  - Use case de liberación de stock en `inventory-service` (hoy no existe: la reserva nunca se deshace).
  - Expiración de reservas impagas reutilizando el patrón de colas con TTL de [ADR-0011](adr/0011-retry-con-backoff-y-dlq.md).
  - Webhooks de la pasarela idempotentes (las pasarelas los reenvían), con el mismo `processed_events` de [ADR-0006](adr/0006-idempotencia-con-processed-events.md).
  - ADR: coreografía (como hoy) vs orquestación de la saga.
- [ ] **Pasarela**: puerto `PaymentGateway` con un adaptador falso primero (tests y e2e sin dependencias externas), después un adaptador real en sandbox (Transbank Webpay Plus o Mercado Pago).

## Paso 5 — Frontend

- [ ] SPA con el mismo stack que el frontend de Monolith (Vite + React + TypeScript + TanStack Query): catálogo, carrito, checkout.
- [ ] Estado de la orden en tiempo real (SSE desde `order-service` en vez de polling).
- [ ] Panel de operaciones: colas DLQ y botón para reprocesar mensajes.
- [ ] Requiere: endpoint HTTP de catálogo (hoy `inventory-service` no expone productos), CORS y autenticación.

## Ideas sin orden asignado

- Herramienta de **redrive de la DLQ** (CLI o endpoint admin): hoy los mensajes que caen ahí se quedan para siempre.
- **Tracing distribuido** con OpenTelemetry + Tempo (ya hay Grafana; el correlation ID de [ADR-0012](adr/0012-logging-json-y-correlation-id.md) es la base).
- **Versión en los contratos** (`event_version` en `BaseEvent`) para poder evolucionar eventos sin romper consumers.
- El resto de "Mejoras futuras" del [README](../README.md#mejoras-futuras-post-mvp): auth JWT en `order-service`, customer directory para el email real, idempotencia persistente en `notification-service`, Kubernetes.
