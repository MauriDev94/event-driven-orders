# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Portfolio project: an order system split into three Python 3.12 / FastAPI microservices that communicate **only through RabbitMQ events** (no service-to-service HTTP). The MVP is complete (phases F0–F9 merged); remaining work is hardening, listed in README "Mejoras futuras" and the open GitHub issues.

- `order-service`: REST API (`POST /v1/orders`, `GET /v1/orders/{id}`) plus a consumer for stock results. Own Postgres.
- `inventory-service`: worker that reserves stock on `order.created`. Own Postgres.
- `notification-service`: worker that emails on `order.confirmed` / `order.rejected` over SMTP (Mailhog). No database.
- `shared/`: uv workspace package imported by all three as `shared.*`.

README, ADRs, commits, PRs and issues are in Spanish; code, comments and docstrings are in English.

## Local environment rules

- **ADR-0020: the single root `.venv/` (uv workspace) is owned by native Windows uv.** Run `uv` directly from PowerShell or Git Bash. Never run `uv` against this `.venv/` from WSL: a venv written by both sides breaks (ADR-0019, now superseded, has the history).
- `.python-version` pins 3.12 to match CI and the Dockerfiles; don't drop it or uv picks the newest interpreter on the machine.
- `make` is not installed on Windows; run the `uv` commands the Makefile wraps (below).
- Most test runs need Docker Desktop running: service DB tests start a `postgres:16-alpine` testcontainer (unless `CI` or `TEST_DB_URL` is set), and `shared/tests/integration/` starts a RabbitMQ testcontainer.
- Tests that boot the real lifespan without a broker (`client` / `api_client` fixtures) take ~35 s each on Windows: `connect_with_retry`'s backoff plus ~2 s per refused TCP connect (instant on Linux). Until the `RabbitMQConnection.connect()` cleanup fix lands (`docs/roadmap.md`, paso 0), they also hang forever at the first `TestClient` teardown, so run `tests/unit` or a specific file rather than a whole service suite.

## Commands

```bash
cp .env.example .env && make up   # RabbitMQ, 2x Postgres, Mailhog, 3 services, Prometheus, Grafana
make ps / make logs / make down
uv sync --all-packages            # every workspace member + dev groups (CI adds --frozen)
make lint                         # per service: ruff check, ruff format --check, mypy app; shared: ruff only
make format
make test                         # pytest + coverage gate per service, then shared (see note below)
make e2e                          # needs `make up` first; tests/e2e with marker e2e
```

Per service, run from the service directory (its pytest `pythonpath` makes `app` importable):

```bash
cd services/order-service
uv run --package order-service pytest -q --cov=app       # what CI runs; enforces fail_under
uv run --package order-service pytest tests/unit/test_order_entity.py::<test_name> -q
uv run --package order-service mypy app
```

`shared`, run from `shared/`:

```bash
uv run --package shared pytest -q -m "not integration"                          # unit tests, no Docker
uv run --package shared pytest -m "integration and not slow" tests/integration/  # 1 forcing test, real RabbitMQ (~70 s cold)
uv run --package shared pytest -m integration tests/integration/                 # all 3 forcing tests (~4.5 min of real TTLs)
```

`make test` runs shared's suite with no marker filter, so it includes the slow RabbitMQ forcing tests. CI runs only ruff on `shared/`, never its tests, and the e2e suite is local-only by design (ADR-0017): run `make e2e` before a PR that touches the event flow.

Coverage gates are `[tool.coverage.report] fail_under` in each service's `pyproject.toml` (order 85, inventory 80, notification 85). README numbers can lag behind.

## Architecture

### Event flow and topology

One durable topic exchange, `orders`. The routing key is always the event's `event_type`:

`POST /v1/orders` → `order.created` → inventory → `stock.reserved` | `stock.rejected` → order-service → `order.confirmed` | `order.rejected` → notification → email.

Each consumer declares only its own queues in `app/core/messaging/topology.py` (`declare_topology`, called from the lifespan). Queues are named `<service>.<purpose>` (`inventory-service.order-created`, `order-service.inventory-results`, `notification-service.order-outcomes`), and every main queue has:

- `<queue>.dlq`: the main queue dead-letters to it through the default exchange (`x-dead-letter-exchange: ""`).
- `<queue>.retry-5s|retry-30s|retry-2m`: TTL queues that dead-letter back to the main queue. Stages come from `shared.messaging.retry_policy.RETRY_STAGES`; a new consumer queue must declare all of them.

Queue and routing-key constants are duplicated per service on purpose: services never import each other.

### `shared/` (src layout: `shared/src/shared/`)

Cross-cutting infrastructure only. No business logic, and it never imports from `services/`.

- `contracts/`: the only wire format (ADR-0003). Every event subclasses `BaseEvent` (`event_id` is the idempotency key, plus `correlation_id` and `occurred_at`) and pins `event_type` with a default equal to its routing key. Services don't share domain entities; each maps domain ⇄ contract in its own `mappers/`.
- `messaging/`: `RabbitMQConnection` (robust connection; `is_connected` reads `connected.is_set()`), `connect_with_retry`, `wrap_with_retry` and `retry_policy`.
- `observability/`: structlog JSON logging (`configure_logging`), correlation-id contextvars, `log_event_received`, Prometheus metrics (`edo_*`).

### Retry and DLQ semantics (they decide how handlers should raise)

Consumers are registered as `wrap_with_retry(handler, channel=..., main_queue_name=...)`. On an exception the dispatcher classifies it:

- `pydantic.ValidationError`, `json.JSONDecodeError` or **any `ValueError`** is permanent: NACK straight to the DLQ.
- Anything else is transient: republish to the next retry queue with `x-retry-count` incremented and ACK the original. After 3 retries it goes to the DLQ.

Domain entities raise `ValueError` on invariant violations (for example, confirming an order that isn't pending), so those never retry. To make a failure retryable, raise something that isn't a `ValueError`.

### Per-service layering (Clean Architecture + DDD, same pattern as Monolith)

`app/features/<feature>/{domain, application/{contracts,usecases,mappers}, infrastructure, presentation/{http,consumers}, di}`, plus `app/core` (config, DB, Alembic, topology, exceptions, middleware) and `app/common/use_case.py` (`UseCase` for sync, `AsyncUseCase` for use cases that await a port).

- Ports live in `application/contracts/` (`EventPublisher`, repositories, `UnitOfWork`). `domain/` and `application/` never import SQLAlchemy or `aio_pika` (PR checklist).
- Consumers are thin adapters built by `build_*_handler(use_case, ...)` factories: validate the contract, map to params, call the use case, `ack`. An unknown `event_type` gets `nack(requeue=False)`. They are wired in each service's `main.py` (`_start_consuming`).
- Lifespan: `connect_with_retry`; if the broker is down, a watchdog task keeps retrying and finishes setup later. A broker failure must never crash the process. `/health` always returns 200 and reports `database` and `broker` in the body (ADR-0013, ADR-0014).

### Consistency patterns (don't regress these)

- **Publish-after-commit** (ADR-0005): commit the DB transaction, then publish. The transaction never spans an `await` on the broker (see `ReserveStock._run_transaction`). The dual-write window is accepted for the MVP; the outbox is future work.
- **Idempotency** (ADR-0006): order and inventory insert the incoming `event_id` into `processed_events` (`INSERT ... ON CONFLICT DO NOTHING`) in the same Unit of Work as the business change, and a duplicate is ACKed with no side effects. notification-service uses `InMemoryEventDeduplicator`, which is lost on restart (ADR-0009).
- **Atomic stock reservation** (ADR-0007): a conditional `UPDATE ... WHERE available_quantity >= :qty` per line inside a `SAVEPOINT`, all-or-nothing. A rejection still commits the `processed_events` row.
- These depend on Postgres semantics, so DB tests run against real Postgres, never SQLite (ADR-0008).
- **Correlation id** (ADR-0012): the order-service middleware binds `X-Correlation-ID` (or a new UUID) to structlog contextvars, the mappers copy it into each event, and `wrap_with_retry` re-binds it from the message body on the consumer side.

### Persistence, build and deploy

- Alembic lives in `app/core/data/source/local/alembic/`, and each container runs `alembic upgrade head` before uvicorn (ADR-0016). Run `alembic` from the service directory, because `alembic.ini` uses a relative path. Inventory's first migration seeds `SKU-001`…`SKU-005` (stock 100/50/25/10/5); the e2e tests and README examples depend on them.
- The Docker build context is the repo root (ADR-0015). Each Dockerfile copies `pyproject.toml`, `uv.lock`, `shared/` and its own service directory, then runs `uv sync --frozen --no-dev --package <svc>`. A new runtime file must not be excluded by the root `.dockerignore`; CI's `build-images` job smoke-imports `shared.*` and `app.main` in every image.
- Production uses the `docker-compose.prod.yml` override plus Caddy (`deploy/Caddyfile`), with env in `.env.production` (template: `deploy/env.production.example`). `DEPLOY.md` is local-only and gitignored.

## Conventions

- TDD is a project rule (see the issue template): failing test first. Separate red/green commits per scenario are normal here.
- Conventional Commits in Spanish, with the service as scope (`fix(inventory): ...`, `test(shared): ...`, `docs(adr): ...`). No emojis in code, commits or PRs. Fill in `.github/PULL_REQUEST_TEMPLATE.md` and link the issue (`Closes #N`).
- Architecture decisions go in a new `docs/adr/NNNN-<slug>.md`, in Spanish, using the format in `docs/adr/README.md`, plus a row in its index. Don't rewrite an accepted ADR; supersede it.
- Task scope and checklists live in the GitHub issue (`.github/ISSUE_TEMPLATE/task.md`). Pending work and review findings go in `docs/roadmap.md`. Non-obvious findings that must outlive the task go in the code's docstrings, an ADR or the README.
- The README is the portfolio showcase: update it when behavior, ports, commands or test counts change.
