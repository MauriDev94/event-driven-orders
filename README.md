# Event-Driven Orders

> Sistema de procesamiento de órdenes basado en eventos — microservicios asíncronos con **RabbitMQ**.
> Portfolio project para demostrar sistemas distribuidos, mensajería y Clean Architecture.

🚧 **Work in progress** — Fase 0 (scaffold + infraestructura) ✅ completada.

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

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) corre en cada push y PR a `main`:

| Job | Qué hace |
|---|---|
| `quality` (matrix × 3 servicios) | `ruff check` + `ruff format --check` + `mypy app` |
| `quality-shared` | `ruff check` + `ruff format --check` sobre `shared/` |
| `tests-db` (matrix: order, inventory) | `pytest` con cobertura sobre un **Postgres 16** efímero (service container con healthcheck `pg_isready`) |
| `tests` (notification) | `pytest` con cobertura, sin DB |

- **Python 3.12** con cache de `pip` por servicio. `actions/checkout@v4`, `actions/setup-python@v5`, `actions/upload-artifact@v4`.
- **Coverage gate:** vive en cada `pyproject.toml` (`[tool.coverage.report] fail_under`). Hoy está en **40** (piso post-scaffold, cobertura real ~46-49%); el objetivo es **85** a medida que crezca la lógica de negocio.
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

## Patrones demostrados

Idempotency keys · Dead-letter queues (DLQ) · Retries con backoff · Eventual consistency · Correlation IDs

> Observabilidad (OpenTelemetry + Jaeger + Prometheus/Grafana) está planificada para una fase posterior al MVP.

## Estado

- [x] **Fase 0** — Scaffold + `docker-compose` (RabbitMQ + Postgres + Mailhog)
- [x] **Fase 0.5** — CI/CD (GitHub Actions), plantillas de GitHub y venv de desarrollo
- [ ] Fase 1 — `order-service`: POST /orders + publica `OrderCreated`
- [ ] Fase 2 — `inventory-service`: consume, reserva stock, idempotencia
- [ ] Fase 3 — `order-service` consume resultado → confirma/rechaza
- [ ] Fase 4 — `notification-service`: consume → email
- [ ] Fase 5 — DLQ + retries con backoff
- [ ] Fase 6 — README final + tests e2e
