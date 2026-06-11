# Event-Driven Orders

> Sistema de procesamiento de órdenes basado en eventos — microservicios asíncronos con **RabbitMQ**.
> Portfolio project para demostrar sistemas distribuidos, mensajería y Clean Architecture.

🚧 **Work in progress** — Fase 6 (hardening de observabilidad: logging JSON + correlation IDs end-to-end) ✅ completada.

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

## Estructura del monorepo

```
event-driven-orders/
├── docker-compose.yml          # RabbitMQ + 2× Postgres + Mailhog + 3 servicios
├── .env.example                # variables para docker-compose
├── Makefile                    # install / up / down / logs / ps / test / lint / format
├── .github/                    # CI (ci.yml) + plantillas de PR/issues + CODEOWNERS
├── shared/contracts/           # integration events (Pydantic): BaseEvent + Order*/Stock*
└── services/
    ├── order-service/          # FastAPI: REST + consumer (feature: orders)
    ├── inventory-service/      # worker: consumer (feature: inventory)
    └── notification-service/   # worker: consumer, sin DB (feature: notifications)
```

Cada servicio: `app/{core,common,features/<feature>/{domain,application,infrastructure,presentation,di}}`.

## Puesta en marcha

```bash
cp .env.example .env
make up        # docker compose up -d --build
make ps        # ver healthchecks
make logs      # seguir logs
make down      # detener
```

| Servicio / infra | URL local |
|---|---|
| order-service `/health` | http://localhost:8001/health |
| inventory-service `/health` | http://localhost:8002/health |
| notification-service `/health` | http://localhost:8003/health |
| RabbitMQ Management | http://localhost:15672 (guest/guest) |
| Mailhog UI | http://localhost:8025 |
| Postgres orders / inventory | localhost:5433 / localhost:5434 |

### API del order-service (Fase 1)

```bash
# Crear una orden (201 + la orden creada; publica OrderCreated al exchange "orders")
curl -X POST http://localhost:8001/v1/orders \
  -H "Content-Type: application/json" \
  -d '{"customer_id": "c-1", "lines": [{"product_id": "p-1", "quantity": 2, "unit_price": "10.00"}]}'

# Consultar una orden (200 / 404)
curl http://localhost:8001/v1/orders/<order_id>
```

> Las rutas están versionadas bajo `/v1` (el router del scaffold ya fija ese prefijo).

### Migraciones (Alembic)

El esquema del `order-service` se versiona con **Alembic** (mismo patrón que el
Monolith). En `docker compose up` la migración se aplica sola al arrancar el
contenedor (`alembic upgrade head` antes de `uvicorn`). En local:

```bash
cd services/order-service
alembic upgrade head        # aplica migraciones (usa db_* del entorno / .env)
alembic history             # ver el historial
alembic check               # verifica que los modelos == la última migración
```

### Entorno de desarrollo local (venv compartido)

Un único `.venv/` en la raíz del monorepo concentra las dependencias de los 3
servicios + las herramientas de dev (ruff, mypy, pytest, pytest-cov). Es solo
para DX local — **Docker sigue usando el `requirements.txt` de cada servicio**
para aislamiento en runtime.

```bash
make install                     # crea .venv e instala runtime + dev de los 3 servicios

# activar el venv:
source .venv/Scripts/activate    # Windows (Git Bash)
source .venv/bin/activate        # Unix / macOS
```

### Tests y lint (local)

```bash
make lint      # ruff check + ruff format --check + mypy en los 3 servicios + ruff sobre shared
make test      # pytest con cobertura en los 3 servicios (respeta el gate)
make format    # ruff format (auto-formatea los 3 servicios + shared)

# por servicio:
cd services/order-service && pytest -q --cov=app
```

> El venv tiene que estar activado: los targets `lint`/`test`/`format` usan
> `ruff`/`mypy`/`pytest` directamente desde el venv.

#### Tests de integración del `inventory-service` (Fase 2)

Los tests de integración del `inventory-service` corren contra **PostgreSQL real** — SQLite no tiene `FOR UPDATE` ni row-level locking:

- **Local**: se lanza automáticamente un `PostgresContainer("postgres:16-alpine")` via `testcontainers-python`. Requiere Docker corriendo. El container arranca la primera vez (~2 min), las siguientes ejecuciones dentro de la misma sesión son rápidas.
- **CI**: el job `tests-db` ya levanta un service container Postgres 16; el conftest detecta `CI=true` y usa las `db_*` env vars directamente sin testcontainers.

```bash
# Docker debe estar corriendo para levantar testcontainers:
cd services/inventory-service && pytest -q --cov=app
```

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) corre en cada push y PR a `main`:

| Job | Qué hace |
|---|---|
| `quality` (matrix × 3 servicios) | `ruff check` + `ruff format --check` + `mypy app` |
| `quality-shared` | `ruff check` + `ruff format --check` sobre `shared/` |
| `tests-db` (matrix: order, inventory) | `pytest` con cobertura sobre un **Postgres 16** efímero (service container con healthcheck `pg_isready`) |
| `tests` (notification) | `pytest` con cobertura, sin DB |

- **Python 3.12** con cache de `pip` por servicio. `actions/checkout@v4`, `actions/setup-python@v5`, `actions/upload-artifact@v4`.
- **Coverage gate:** vive en cada `pyproject.toml` (`[tool.coverage.report] fail_under`). `order-service` y `notification-service` están en **85** (cobertura real ~91% y ~93% respectivamente); `inventory` sigue en **40** (piso post-scaffold) hasta que crezca su lógica.
- El `coverage.xml` de cada servicio se sube como artefacto (`coverage-<servicio>`).
- **Secret opcional `CI_DB_PASSWORD`:** password del Postgres de CI. Si no está seteado, el workflow usa un valor descartable para que el CI quede verde sin configuración manual.

## Decisiones de arquitectura (Fase 0)

- **Build context = raíz del repo** (no la carpeta del servicio): cada `Dockerfile` se referencia vía `build.dockerfile` para poder copiar `shared/` dentro de cada imagen. Es el patrón estándar de monorepo; apuntar el contexto a la carpeta del servicio rompería el import de `shared.contracts`.
- **`shared/contracts/` como única fuente de los integration events.** Los servicios NO comparten entidades de dominio; solo estos modelos Pydantic viajan por el broker. Cada servicio mapea entre su dominio y estos contratos.
- **El broker es un detalle de infraestructura.** Los use cases dependen del puerto `EventPublisher` (en `application/contracts/`); la implementación con `aio-pika` vive en `infrastructure/messaging/`.
- **`presentation/` = puntos de entrada (adapters).** En order-service: `presentation/http/` (routers + schemas) y `presentation/consumers/` (handlers de eventos). En los workers: solo `presentation/consumers/`.
- **Workers exponen un FastAPI mínimo solo para `/health`** (probe de Docker/k8s). El consumo real de eventos se inicia en el `lifespan` en fases posteriores.
- **`/health` siempre responde 200** y reporta el estado de cada dependencia (DB/broker) en el body — distingue "proceso arriba" de "dependencia degradada" sin depender del status code. Esto hace el smoke test verde sin infra levantada.
- **database-per-service:** `order-service` y `inventory-service` tienen cada uno su Postgres; `notification-service` no tiene DB en Fase 0.
- **Deps por servicio:** `requirements.txt` (runtime, usado por el Dockerfile) + `requirements-dev.txt` (pytest/ruff) + `pyproject.toml` (config de ruff y pytest). Mismo patrón que el proyecto Monolith de referencia.

## Decisiones de arquitectura (Fase 2)

- **Idempotencia vía tabla `processed_events`.** RabbitMQ es *at-least-once*: el mismo `OrderCreated` puede llegar dos veces. El `event_id` se registra dentro de la **misma transacción** que los decrementos de stock con `INSERT ... ON CONFLICT DO NOTHING`. Si ya existía → `rowcount == 0` → el use case hace ACK sin re-procesar y sin re-publicar. Rechazos también registran su `event_id`, así que un redelivery de un pedido rechazado tampoco republica el `StockRejected`.

- **Reserva atómica anti race-condition.**  
  ```sql
  UPDATE products
  SET    available_quantity = available_quantity - :qty
  WHERE  sku = :sku AND available_quantity >= :qty
  ```
  Postgres evalúa el `WHERE` con row-level locking: dos transacciones concurrentes para el mismo SKU se serializan. Si `rowcount == 0` → stock insuficiente. Además, un `SAVEPOINT reserve_all` envuelve todos los decrementos (all-or-nothing): si cualquier línea falla, se hace `ROLLBACK TO SAVEPOINT` y el UoW puede aún hacer commit del `event_id` (para evitar que la delivery se repita eternamente).

- **Unit of Work (UoW) como contrato de transacción.** `register_event` + `reserve_all` comparten la misma sesión SQLAlchemy. El use case hace `uow.commit()` después de ambas operaciones: el `event_id` y los decrementos de stock commitean juntos. Si el broker falla *después* del commit, la orden ya está reservada pero `StockReserved` no se publicó — la misma ventana dual-write que en la Fase 1 (publish-after-commit, MVP). El endurecimiento es un outbox transaccional (Fase posterior).

- **Tests con PostgreSQL real (testcontainers).** SQLite no tiene `FOR UPDATE` ni row-level locking reales, lo que haría pasar los tests de race-condition sin probar nada (falsa confianza). Los tests de integración usan `testcontainers[postgres]` local y el service container de CI. El conftest detecta el entorno automáticamente: si `CI=true` → usa las `db_*` env vars del job; si no → lanza `PostgresContainer("postgres:16-alpine")`.

- **Migración Alembic + seed de productos.** La migración `a1b2c3d4e5f6` crea `products` + `processed_events` e inserta 5 productos con stock inicial (SKU-001..005) para poder probar el flujo end-to-end sin datos manuales. El Dockerfile corre `alembic upgrade head` antes de `uvicorn`.

- **Consumer como adapter puro (capa presentation).** `build_order_created_handler` es una factory que recibe un `ReserveStock` ya construido y retorna el coroutine de aio-pika. Cero lógica de negocio en el consumer: deserializa, construye `ReserveStockParams`, invoca el use case, y ACK. Testeable sin broker real.

## Decisiones de arquitectura (Fase 4)

- **Sin idempotencia persistente (limitación documentada del MVP).** A diferencia de `order-service` (Fase 3, tabla `processed_events`), `notification-service` no tiene base de datos por diseño — es un consumer puro que solo habla con SMTP. RabbitMQ es *at-least-once*, así que un redelivery de `OrderConfirmed`/`OrderRejected` (p. ej. si el proceso muere después del `send()` pero antes del `ack()`) puede reenviar el mismo email al cliente. Para el MVP se acepta esta limitación: un email duplicado es molesto pero no corrompe estado de negocio (a diferencia de un doble decremento de stock). **Mitigación futura (Fase 5+):** tabla `processed_events` con `INSERT ... ON CONFLICT DO NOTHING` sobre `event_id` (mismo patrón de Fase 2/3), o dedup en el `EmailSender` a nivel de adapter.

- **Destinatario derivado del `customer_id` (limitación documentada del MVP).** Los eventos `OrderConfirmed`/`OrderRejected` (`shared/contracts/order_events.py`) llevan `customer_id`, no un email. El MVP no tiene un servicio/directorio de clientes que resuelva `customer_id → email`, así que el mapper (`application/mappers/order_event_mapper.py`) deriva un placeholder determinístico `{customer_id}@example.com`. En un sistema real esto sería una consulta a un customer-service o a una tabla de perfiles.

- **Patrón factory del consumer (igual que Fases 2/3).** `build_order_events_handler(use_case)` cierra sobre `SendOrderNotification` ya wireado y retorna el coroutine de aio-pika. Deserializa, dispatch por `event_type` (`order.confirmed` / `order.rejected`), mapea a params, ejecuta el use case y hace ACK. `event_type` desconocido → NACK sin requeue (dead-letter). Testeable sin broker real (mensajes fake) y sin SMTP real (`EmailSender` spy/fake).

- **Puerto `EmailSender`, no `smtplib` directo.** El use case `SendOrderNotification` depende del contrato `application/contracts/email_sender.py`; `SmtpEmailSender` (target Mailhog) vive en `infrastructure/email/`. Los tests de integración del adapter mockean `smtplib.SMTP` — nunca abren un socket real.

## Decisiones de arquitectura (Fase 5)

- **Retry-with-backoff + DLQ compartidos en `shared/messaging/`.** `retry_policy.py` (clasificación de errores + decisión de retry/DLQ, puro y testeado en `unit`) y `retry_dispatcher.py` (`wrap_with_retry`, side-effecting: ack/nack/republish, testeado en `unit` con AsyncMock) se implementaron una sola vez y se reusan en los 3 servicios. `wrap_with_retry(handler, channel=..., main_queue_name=...)` envuelve el handler de cada consumer en su `lifespan`.

- **Backoff de 3 etapas vía colas TTL + DLX (sin plugins).** Por cada cola principal `<queue>` se declaran 3 colas de retry: `<queue>.retry-5s` (TTL 5s), `<queue>.retry-30s` (TTL 30s) y `<queue>.retry-2m` (TTL 120s). Cada una tiene `x-dead-letter-exchange: ""` + `x-dead-letter-routing-key: <queue>`, así que al expirar el TTL el mensaje vuelve solo (vía exchange por defecto, ruteo por nombre de cola — sin bindings) a la cola principal para reintentarse. `MAX_RETRIES = 3` (= cantidad de etapas, `shared/messaging/retry_policy.py`).

- **Contador de intentos en header `x-retry-count`.** El dispatcher lee `x-retry-count` del mensaje (default 0). Si el handler falla: clasifica la excepción → si es `TRANSIENT` y `retry_count < MAX_RETRIES`, republica a `<queue>.retry-{etapa correspondiente}` con `x-retry-count` incrementado y hace ACK del mensaje original (la cola de retry es la que reintroduce el mensaje tras el TTL). Si es `PERMANENT` o ya se agotaron los 3 reintentos → `nack(requeue=False)`, lo que lo manda directo a `<queue>.dlq` vía el `x-dead-letter-exchange` de la cola principal.

- **Clasificación transient vs permanent (`classify_exception`).** `pydantic.ValidationError`, `json.JSONDecodeError` y `ValueError` (payload malformado o `event_type`/outcome desconocido) son **PERMANENT** → DLQ inmediato, sin gastar reintentos (no tiene sentido reintentar un mensaje que siempre va a fallar igual). Cualquier otra excepción (p. ej. `RuntimeError` por caída de Postgres o de SMTP) es **TRANSIENT** → sigue el backoff.

- **Fix de un bug de Fases 1-4: DLQ "fantasma".** Las 3 colas principales declaraban `x-dead-letter-exchange: "orders.dlx"`, un exchange topic que **nunca se declaraba ni bindeaba** a la `.dlq` correspondiente — un exchange topic sin binding matcheante descarta el mensaje silenciosamente (no es como el exchange por defecto). Resultado: cualquier `nack(requeue=False)` previo a Fase 5 perdía el mensaje para siempre, sin error visible. Fase 5 lo corrige usando el exchange por defecto (`""`) + `x-dead-letter-routing-key: <queue>.dlq` (ruteo por nombre de cola, no requiere binding). Cubierto por `tests/integration/test_topology.py` en los 3 servicios.

- **Idempotencia hace que los reintentos sean seguros.** `order-service` e `inventory-service` ya tenían `processed_events` (Fase 2/3) — un redelivery tras un retry no duplica efectos de negocio. `notification-service` no tiene base de datos (Fase 4); Fase 5 agrega `InMemoryEventDeduplicator` (`infrastructure/dedup/`, set acotado FIFO de `event_id` vistos) para que un redelivery dentro del mismo proceso no reenvíe el email. Limitación documentada: un redelivery justo después de un *restart* del proceso puede igual reenviar un email duplicado (el dedup en memoria no sobrevive reinicios) — mitigación completa requeriría `processed_events` persistente, fuera de alcance del MVP.

- **Inspeccionar las DLQ en RabbitMQ Management UI** (`http://localhost:15672`, user/pass `guest`/`guest`): pestaña *Queues*, buscar `<service>.<queue>.dlq` (p. ej. `order-service.inventory-results.dlq`, `inventory-service.order-created.dlq`, `notification-service.order-outcomes.dlq`). El botón *Get messages* permite ver el body + headers (`x-retry-count`, `x-death`) del mensaje muerto. Las colas de retry (`<queue>.retry-5s/30s/2m`) muestran mensajes "en tránsito" mientras esperan su TTL.

## Decisiones de arquitectura (Fase 6)

- **Logging estructurado (JSON) centralizado en `shared/observability/`.** `configure_logging(service_name)` configura `structlog` + el `logging` estándar para que **toda** línea de log (propia o de librerías como `uvicorn`/`aio-pika`) salga como un único JSON con `timestamp`, `level`, `logger`, `event` (mensaje) y campos contextuales. Se usan dos cadenas de procesadores: una para loggers de `structlog` y un `foreign_pre_chain` (`structlog.stdlib.ProcessorFormatter`) para loggers del `logging` estándar, de modo que ambos terminen en el mismo `JSONRenderer`. Cada servicio llama `configure_logging("<service>")` una sola vez al importar `app.main`, lo que agrega el campo fijo `service` a cada línea.

  ```json
  {"timestamp": "2026-06-10T12:00:00Z", "level": "info", "logger": "app.core.middleware.correlation_id",
   "event": "request completed", "service": "order-service", "correlation_id": "a1b2c3d4-...",
   "method": "POST", "path": "/v1/orders", "status_code": 201, "duration_ms": 12.4}
  ```

- **Correlation ID end-to-end vía `structlog.contextvars`.** `shared/observability/context.py` expone `bound_correlation_id(id)` (context manager) y `get_correlation_id()`, wrappers finos sobre `bind_contextvars`/`reset_contextvars`/`get_contextvars`. Mientras el contexto está bindeado, **todas** las líneas de log emitidas (incluso desde código que no recibe el id explícitamente) llevan `correlation_id` gracias al processor `merge_contextvars`.

- **Middleware de correlation ID + request logging en `order-service`** (`app/core/middleware/correlation_id.py`). Por cada request HTTP:
  1. Lee el header `X-Correlation-ID`; si no viene, genera un `uuid4()`.
  2. Bindea el id al contexto de `structlog` con `bound_correlation_id(...)` para toda la duración del request.
  3. Al terminar, emite un log `"request completed"` con `method`, `path`, `status_code` y `duration_ms` (todos JSON, todos con `correlation_id`).
  4. Devuelve el id en el header `X-Correlation-ID` de la respuesta, para que el cliente pueda correlacionar sus propios logs.

- **Propagación a través del broker.** `BaseEvent.correlation_id` (ya existía desde Fase 1) viaja en cada evento. `map_order_to_order_created` ahora setea `correlation_id = get_correlation_id() or order.id` — es decir, **el trace id del request HTTP que originó la orden**, con fallback a `order.id` solo si no hay contexto HTTP bindeado (p. ej. un test que invoca el use case directamente). Esto separa la **identidad de negocio** (`order.id`, estable) de la **identidad de traza** (`correlation_id`, por request/cadena de eventos) — antes ambas eran el mismo valor.

  En el otro extremo, `wrap_with_retry` (`shared/messaging/retry_dispatcher.py`) extrae `correlation_id` del body del evento entrante y lo bindea con `bound_correlation_id(...)` durante todo el `dispatch` del handler. Como **los 3 servicios** usan `wrap_with_retry` para envolver sus consumers (Fase 5), este es el **único punto de integración** necesario: cada consumer (`inventory-service` al recibir `OrderCreated`, `order-service` al recibir `StockReserved`/`StockRejected`, `notification-service` al recibir `OrderConfirmed`/`OrderRejected`) automáticamente loguea con el `correlation_id` del evento, sin tocar el código de cada handler.

- **Filtrar logs por `correlation_id` para trazar un flujo completo.** Como cada línea es JSON, con `jq` se puede seguir una orden de punta a punta a través de los 3 servicios:

  ```bash
  docker compose logs order-service inventory-service notification-service --no-color \
    | grep -o '{.*}' \
    | jq -c 'select(.correlation_id == "a1b2c3d4-5678-90ab-cdef-1234567890ab")'
  ```

  Esto muestra, en orden cronológico, el `request completed` del POST `/v1/orders`, la reserva de stock en `inventory-service`, la confirmación en `order-service` y el envío de email en `notification-service` — todos con el mismo `correlation_id`, aunque cada uno corre en un proceso distinto.

- **Tests de logging "difíciles de hacer TDD".** La configuración de logging es infraestructura pura (efecto secundario global sobre `structlog`/`logging`), así que en vez de TDD clásico se escribieron **tests de comportamiento**: capturan la salida con `structlog.testing.LogCapture` (no `capture_logs()`, que en structlog 26.x reemplaza toda la cadena de procesadores y descarta `merge_contextvars`) y verifican JSON válido + presencia/ausencia de `correlation_id` + el campo `service` correcto por servicio (`shared/tests/test_observability_config.py`, `services/*/tests/unit/test_logging_config.py`).

---

## Decisiones de arquitectura (Fase 1)

- **Use case asíncrono (`AsyncUseCase`).** El puerto `EventPublisher.publish` es `async` (aio-pika), así que `CreateOrder.execute` tiene que poder `await`. Se añadió una base `AsyncUseCase` en `common/` separada de la `UseCase` síncrona para que el límite sync/async sea explícito a nivel de tipos. `GetOrder` queda síncrono.
- **Consistencia: publish-after-commit (MVP).** El use case primero persiste+commitea la orden y *después* publica `OrderCreated`. Esto deja una ventana de *dual-write*: si la publicación falla, la orden existe pero no se emitió el evento. Es aceptable para el MVP; el endurecimiento es un **outbox transaccional** (Fase 2+).
- **`correlation_id = order_id`.** El id de la orden correlaciona todos los eventos de su ciclo de vida (`order.created` → `stock.reserved` → `order.confirmed`…) para tracing end-to-end.
- **El use case retorna la entidad de dominio `Order`**; el endpoint la mapea a `OrderResponse` con un mapper de presentación (dirección válida *Domain Entity → Response Schema*). La entidad nunca se expone directa como respuesta HTTP.
- **`declare_topology()` en el `lifespan`.** Al conectar el broker se declaran exchange/queues/bindings (idempotente en RabbitMQ, seguro en cada arranque). Si el broker no está disponible, el arranque sigue resiliente y `/health` lo reporta degradado.
- **Rutas versionadas (`/v1/orders`).** Se respeta el prefijo `/v1` que ya fijaba el router del scaffold.
- **Migraciones con Alembic** replicando el patrón del Monolith (`env.py` resuelve la URL desde `DATABASE_URL` o `db_*`). `alembic check` confirma que la migración inicial calza exacto con los modelos ORM. El contenedor corre `alembic upgrade head` al arrancar para que la tabla `orders` exista antes de servir.
- **Tests sin infraestructura real.** Los tests de integración inyectan por `dependency_overrides` un **SQLite in-memory** (persistencia real, sin Postgres) y un **publisher spy** (captura de eventos, sin RabbitMQ). La cobertura es determinística → CI == local.

## Patrones demostrados

Idempotency keys · Dead-letter queues (DLQ) · Retries con backoff · Eventual consistency · Correlation IDs · Logging estructurado (JSON)

> Tracing distribuido (OpenTelemetry + Jaeger) y métricas (Prometheus/Grafana) están planificados para una fase posterior al MVP. Fase 6 ya cubre correlation IDs end-to-end y logging JSON, que son la base para esa instrumentación.

## Estado

- [x] **Fase 0** — Scaffold + `docker-compose` (RabbitMQ + Postgres + Mailhog)
- [x] **Fase 0.5** — CI/CD (GitHub Actions), plantillas de GitHub y venv de desarrollo
- [x] **Fase 1** — `order-service`: POST /orders + GET /orders/{id} + publica `OrderCreated` (Alembic, cobertura ~88%)
- [x] **Fase 2** — `inventory-service`: consume `OrderCreated`, reserva atómica (anti race-condition), idempotencia (Alembic + seed, cobertura ~84%)
- [x] **Fase 3** — `order-service`: consume `StockReserved`/`StockRejected` → `ConfirmOrder`/`RejectOrder`, idempotencia (UoW + `processed_events`), publica `OrderConfirmed`/`OrderRejected`, retrofit a Postgres real en tests (cobertura ~91%)
- [x] **Fase 4** — `notification-service`: consume `OrderConfirmed`/`OrderRejected` → email vía `EmailSender` (SMTP/Mailhog), gate de cobertura subido a 85 (cobertura real ~93%)
- [x] **Fase 5** — DLQ + retries con backoff (3 etapas: 5s/30s/2m, `x-retry-count`, fix de DLQ "fantasma" Fases 1-4, dedup en memoria en `notification-service`)
- [x] **Fase 6** — Hardening de observabilidad: logging estructurado (JSON) en los 3 servicios + correlation ID end-to-end (HTTP → eventos → consumers) + middleware de request logging en `order-service`
- [ ] Fase 7 — README final + tests e2e
