# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Portfolio project: an order system split into three Python 3.12 / FastAPI microservices plus one TypeScript / NestJS service, all communicating **only through RabbitMQ events** (no service-to-service HTTP). The MVP is complete (phases F0–F9 merged), and so is roadmap step 3 (`assistant-service`, all phases of `docs/plan-assistant-service.md`); pending work lives in `docs/roadmap.md` (next: step 4, the deploy) and the open GitHub issues.

- `order-service`: REST API (`POST /v1/orders`, `GET /v1/orders/{id}`) plus a consumer for stock results. Own Postgres.
- `inventory-service`: worker that reserves stock on `order.created`. Own Postgres.
- `notification-service`: worker that emails on `order.confirmed` / `order.rejected` over SMTP (Mailpit). No database.
- `assistant-service`: NestJS 12 / TypeScript. Projects all five events into its own Postgres read model and serves `GET /v1/assistant/orders/{id}/timeline` and `POST /v1/assistant/ask`, an LLM agent (Gemini, or a keyless `fake` by default) with read-only tools over that read model (port 8004). Redis holds the ask rate limit and a timeline cache. Outside the uv workspace and never imports `shared/` (ADR-0021); see its section below.
- `shared/`: uv workspace package imported by the three Python services as `shared.*`.

README, ADRs, commits, PRs and issues are in Spanish; code, comments and docstrings are in English.

## Local environment rules

- **ADR-0020: the single root `.venv/` (uv workspace) is owned by native Windows uv.** Run `uv` directly from PowerShell or Git Bash. Never run `uv` against this `.venv/` from WSL: a venv written by both sides breaks (ADR-0019, now superseded, has the history).
- `.python-version` pins 3.12 to match CI and the Dockerfiles; don't drop it or uv picks the newest interpreter on the machine.
- `make` (GNU Make 4.4, `winget install ezwinports.make`) runs from Git Bash. A shell opened before the install doesn't have it in `PATH`.
- `.env` is generated, never copied by hand: `make env` (`scripts/generate_env.py`) fills every empty `*_PASS` / `*_PASSWORD` of `.env.example` with a random value, and compose refuses to start when one is missing (`${VAR:?}`). No password gets a value in `.env.example`, compose, CI or code: CI's Postgres uses trust auth and `build-images` runs the same script. On an existing `.env`, `make env` keeps every value and only appends the template keys it lacks (fresh secrets for those), so a new service's database needs no `down -v`. `GEMINI_API_KEY` is the one secret it can't generate: it stays empty (with `LLM_PROVIDER=fake`) until the user pastes a Google AI Studio key into `.env` themselves. Regenerating with `--force` needs `docker compose down -v`, because Postgres, Grafana and RabbitMQ keep the password their volume was created with. Keep the compose guards as a bare `${VAR:?}`: with an error message after the `?`, GitGuardian's generic password detector reads the line as a literal (it flagged PR #48), and it scans every commit of a PR, so a later fix commit doesn't clear it.
- A global hook blocks any shell command whose text contains `.env` (except `.env.example`), even inside a heredoc or a Python string. Put such edits in a script file and run it, and never print a generated value.
- Most test runs need Docker Desktop running: service DB tests start a `postgres:16-alpine` testcontainer (unless `CI` or `TEST_DB_URL` is set), and `shared/tests/integration/` starts a RabbitMQ testcontainer. assistant-service's Vitest global setup starts a Postgres testcontainer unless `TEST_DATABASE_URL` is set and a Redis one (`redis:8.8-alpine`, random password) unless `TEST_REDIS_URL` is set; its consumer test starts a RabbitMQ one.
- The `client` / `api_client` fixtures run the real lifespan with `app.main.connect_with_retry` replaced by a broker-down double, so service suites never open a socket to RabbitMQ, not even with `make up` running. Don't drop it: on Windows a refused TCP connect takes ~2 s, so the real backoff costs ~35 s per test. Tests of the lifespan's broker logic patch `RabbitMQConnection` / `connect_with_retry` themselves (`test_lifespan_*.py`). In order and inventory, `db_session_override` (used by `client` and `api_client`) points `get_db_session` at the test Postgres, `/health` included; a test that calls `/health` without those fixtures needs `@pytest.mark.usefixtures("db_session_override")`.

## Commands

```bash
make env && make up               # .env with random passwords, then RabbitMQ, 3x Postgres, Redis, Mailpit, 4 services, Prometheus, Grafana
make ps / make logs / make down
uv sync --all-packages            # every workspace member + dev groups (CI adds --frozen)
make lint                         # per service: ruff check, ruff format --check, mypy app; shared: same, with mypy src
make format
make test                         # pytest + coverage gate per service, then shared's unit tests (no Docker for shared)
make test-broker                  # the 3 retry/DLQ forcing tests against a real RabbitMQ (~4.5 min)
make e2e                          # needs `make up` first; tests/e2e with marker e2e
```

`make install`, `lint`, `test` and `format` also run the npm steps of assistant-service.

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

assistant-service, run from `services/assistant-service/` (Node 24, npm):

```bash
npm ci
npm run test:cov                 # Vitest: unit, integration and Nest e2e; gate in vitest.config.ts (lines/statements 80)
npx vitest run test/unit/core/messaging/retry-policy.spec.ts -t "<test name>"
npm run lint && npm run typecheck && npm run format:check   # oxlint --type-aware, tsc --noEmit, prettier
```

`prisma generate` runs as a pre-script of lint, typecheck and test; the client goes to `src/generated/` (gitignored). After changing a contract in `shared/contracts`, regenerate the zod fixtures from the repo root with `uv run --package shared python scripts/export_contract_fixtures.py` (CI runs it with `--check`).

CI runs shared's lint, mypy and unit tests, plus the fast forcing test (`tests-broker` job). The two `slow` forcing tests and the e2e suite are local-only (ADR-0017 for e2e): run `make test-broker` before a PR that touches retry/DLQ, and `make e2e` before one that touches the event flow.

Coverage gates are `[tool.coverage.report] fail_under` in each service's `pyproject.toml` (order 85, inventory 80, notification 85). README numbers can lag behind.

## Architecture

### Event flow and topology

One durable topic exchange, `orders`. The routing key is always the event's `event_type`:

`POST /v1/orders` → `order.created` → inventory → `stock.reserved` | `stock.rejected` → order-service → `order.confirmed` | `order.rejected` → notification → email. assistant-service consumes all five and publishes nothing.

Each consumer declares only its own queues in `app/core/messaging/topology.py` (`declare_topology`, called from the lifespan). Queues are named `<service>.<purpose>` (`inventory-service.order-created`, `order-service.inventory-results`, `notification-service.order-outcomes`, `assistant-service.order-events`), and every main queue has:

- `<queue>.dlq`: the main queue dead-letters to it through the default exchange (`x-dead-letter-exchange: ""`).
- `<queue>.retry-5s|retry-30s|retry-2m`: TTL queues that dead-letter back to the main queue. Stages come from `shared.messaging.retry_policy.RETRY_STAGES`; a new consumer queue must declare all of them.

Queue and routing-key constants are duplicated per service on purpose: services never import each other.

Queues and persistent messages survive a recreated broker container: they live in the `rabbitmq_data` volume, under a directory named after the node, which is why compose pins `hostname: rabbitmq`. RabbitMQ refuses to redeclare an existing queue with different arguments (`PRECONDITION_FAILED`) and `_start_consuming` only logs it, so changing a queue's arguments needs that queue deleted first (`docker compose down -v` locally).

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
- **One engine per process**: sessions come from `get_database()` (`lru_cache`), shared by the routers, `/health` and the consumer. Building a `Database` per call opens a connection per request and leaks idle ones on error paths.
- **Correlation id** (ADR-0012): the order-service middleware binds `X-Correlation-ID` (or a new UUID) to structlog contextvars, the mappers copy it into each event, and `wrap_with_retry` re-binds it from the message body on the consumer side.

### Persistence, build and deploy

- Alembic lives in `app/core/data/source/local/alembic/`, and each container runs `alembic upgrade head` before uvicorn (ADR-0016), with `exec uvicorn` so uvicorn is PID 1 and gets SIGTERM (`sh` doesn't forward it, and the lifespan shutdown would never run). Run `alembic` from the service directory, because `alembic.ini` uses a relative path. Inventory's first migration seeds `SKU-001`…`SKU-005` (stock 100/50/25/10/5); the e2e tests and README examples depend on them.
- The Docker build context is the repo root (ADR-0015). Each Python Dockerfile copies `pyproject.toml`, `uv.lock`, `shared/` and its own service directory, then runs `uv sync --frozen --no-dev --package <svc>`. A new runtime file must not be excluded by the root `.dockerignore`; CI's `build-images` job builds every image on amd64 and on a native arm64 runner (the prod VM is arm64), smoke-imports `shared.*` and `app.main` in each (assistant-service: `dist/app.module.js` and `prisma --version`), and on arm64 also pulls every third-party image of the prod stack.
- Production uses the `docker-compose.prod.yml` override plus Caddy (`deploy/Caddyfile`), with env in `.env.production` (template: `deploy/env.production.example`). The deploy guide (Oracle Cloud Always Free, ARM) is `docs/deploy.md`.

### `assistant-service` (TypeScript, ADR-0021)

Same layering and the same rules as the Python services, in `src/features/<feature>/{domain,application/{contracts,usecases,mappers},infrastructure,presentation/{http,consumers}}`; each feature's Nest module is its `di/`. Ports are abstract classes. `domain/` and `application/` never import Prisma, amqplib or Nest.

- ESM (`"type": "module"`, `nodenext`): relative imports end in `.js`. Toolchain is what NestJS CLI 12 generates: Vitest, oxlint, Prettier, TypeScript 6.
- **Contracts:** zod schemas in `src/core/messaging/contracts.ts` mirror `shared/contracts` by hand. Decimals arrive as strings (`"25.50"`) and are stored as `numeric`. The contract tests parse `test/fixtures/contracts/*.json`, exported from the Pydantic models; a contract change needs both the zod edit and regenerated fixtures.
- **Messaging:** `RabbitMQConnection` uses amqplib 2's native recovery (no amqp-connection-manager). Consumers register with `addSetup` from `onModuleInit`, and every setup re-runs on each reconnection (topology, prefetch 10, consume). `/health` reports the broker healthy only after the setups ran. `wrapWithRetry` and `retry-policy.ts` mirror `shared.messaging` by hand: `ZodError`, `InvalidMessageError` and `DomainError` (the `ValueError` equivalent) go to the DLQ, anything else retries. A change to the Python retry protocol has to be ported here; nothing checks it automatically.
- **Persistence:** Prisma 7 (config in `prisma7.config.ts`, generator `prisma-client`, `@prisma/adapter-pg`). The container runs `prisma migrate deploy` before `exec node dist/main.js`, and the test global setup applies the same migrations to a template database that each test file clones. Idempotency is the `order_event_log.event_id` PK (`createMany` with `skipDuplicates`) in the same transaction as the `order_view` change; `order_view.version` is an optimistic lock whose `ConcurrentUpdateError` is transient, so it retries.
- **Out-of-order events** are the domain's job: `OrderView.apply` lets a late `order.created` fill in the details without touching the status, and throws `DomainError` on impossible transitions.
- Integration tests start containers with random passwords. `@testcontainers/rabbitmq` is not used because it hardcodes guest/guest; the test uses `GenericContainer`.
- Like the Python consumers, a duplicate isn't counted in `edo_events_processed_total`.
- **Agent (ADR-0022):** the loop lives in the `AskAssistant` use case; the `LlmClient` port does one turn (tool calls or final text). Caps: 5 turns, 5 tool calls per turn, 30 s per question, 500-character questions. The tools in `application/tools/order-tools.ts` are read-only queries behind the `OrderQueries` port; their JSON Schema comes from zod, and bad arguments go back to the model as `{ error }`. `GeminiLlmClient` replays each model turn's original `Content` (`providerData`) so Gemini 3 thought signatures survive, and maps a 429 to `LlmQuotaExceededError` (503, no retry loop). `LLM_PROVIDER=gemini` requires `GEMINI_API_KEY`; `fake` (the default everywhere) needs nothing, and no test uses the network.
- **Grounding:** citations are built server-side from what the tools returned (`domain/evidence.ts`), never parsed from the model's text. `groundAnswer` replaces any answer that mentions a UUID no tool returned (and the question didn't contain) with the fixed no-data sentence, outcome `ungrounded`.
- **Redis (ADR-0023):** one `RedisConnection` (node-redis 6, offline queue off, 1 s command timeout) connects in the background like the broker and shows up as `redis` in `/health`. The ask rate limit (fixed window per IP, `INCR` + `EXPIRE NX` + `TTL` in a `MULTI`) fails closed: Redis down means 503. The timeline cache (`TimelineCache` port, `RedisTimelineCache`) fails open, is invalidated by `ProjectOrderEvent` after the commit, and keys every entry to a per-order generation counter so a read racing an invalidation can't store a stale timeline. Don't replace that with a plain `DEL`.
- `req.ip` drives the rate limit, so `TRUST_PROXY` (`app.setup.ts`) must stay `false` locally and `uniquelocal` behind Caddy in prod; any other value lets clients spoof `X-Forwarded-For` or puts everyone in one bucket.
- Nest e2e and integration tests build the app with `test/support/test-app.ts` (`createTestApp`), which wires the test Postgres and Redis, lets a test swap the broker or the LLM, and waits for Redis before returning. `randomIp()` gives each test its own rate-limit bucket.

## Conventions

- TDD is a project rule (see the issue template): failing test first. Separate red/green commits per scenario are normal here.
- Conventional Commits in Spanish, with the service as scope (`fix(inventory): ...`, `test(shared): ...`, `docs(adr): ...`). No emojis in code, commits or PRs. Fill in `.github/PULL_REQUEST_TEMPLATE.md` and link the issue (`Closes #N`).
- Architecture decisions go in a new `docs/adr/NNNN-<slug>.md`, in Spanish, using the format in `docs/adr/README.md`, plus a row in its index. Don't rewrite an accepted ADR; supersede it.
- Task scope and checklists live in the GitHub issue (`.github/ISSUE_TEMPLATE/task.md`). Pending work and review findings go in `docs/roadmap.md`. Non-obvious findings that must outlive the task go in the code's docstrings, an ADR or the README.
- The README is the portfolio showcase: update it when behavior, ports, commands or test counts change.
