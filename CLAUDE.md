# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Portfolio project: an order system split into three Python 3.12 / FastAPI microservices plus one TypeScript / NestJS service, all communicating **only through RabbitMQ events** (no service-to-service HTTP). The MVP is complete (phases F0–F9 merged), and so is roadmap step 3 (`assistant-service`, all phases of `docs/plan-assistant-service.md`); pending work lives in `docs/roadmap.md` (step 4: the deploy is on hold since 2026-11-01, so next come the README GIF and the study guide) and the open GitHub issues.

- `order-service`: REST API (`POST /v1/session`, then `POST /v1/orders` and `GET /v1/orders/{id}` with `Authorization: Bearer`, see the sessions section) plus a consumer for stock results. Own Postgres.
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
npm run eval                     # eval set (eval/) with the fake model: no key, no Docker, no network
npm run eval:gemini              # same set against real Gemini; reads GEMINI_API_KEY and LLM_MODEL from the root .env
```

The eval set (`eval/`, run with tsx, not part of the build or coverage) asks the 16 cases of `eval/cases.ts` through the real `AskAssistant` over `InMemoryOrderQueries` and scores them with fixed rules (`eval/score.ts`). `eval:gemini` spends real quota (~28 calls per run): it spaces calls 4.5 s apart, stops at the first quota error or at `EVAL_MAX_MODEL_CALLS` (100), and isn't run in CI. Save notable runs in `eval/results/` and update the score in the README.

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
- Production uses the `docker-compose.prod.yml` override plus Caddy (`deploy/Caddyfile`: `/v1/assistant/*` goes to assistant-service and the rest of the root domain to order-service), with env in `.env.production` (template: `deploy/env.production.example`). The deploy guide (Oracle Cloud Always Free, ARM) is `docs/deploy.md`.

### Anonymous sessions in order-service (ADR-0027)

- `app/features/session/`: `POST /v1/session` returns `{ access_token, token_type: "bearer", expires_in }` and stores nothing. `TokenIssuer` / `TokenVerifier` are ports in `application/contracts`; the PyJWT adapters are in `infrastructure`. The `sub` is a random UUID, so it satisfies `ID_PATTERN` / `ID_MAX_LENGTH` (36), which are defined once in `app/common/identifiers.py` and reused, never copied (the orders schemas and the token verifier both import them; neither feature imports the other).
- **Token contract** (fixed in `session/domain/token_claims.py`; assistant-service mirrors it by hand, so a change here is a change there): HS256, `iss="order-service"`, `aud="event-driven-orders"`, `typ="session"`, `exp` 7 days after `iat`, 30 s of leeway, required claims `exp iat iss aud sub typ`. No refresh, no revocation.
- `get_current_customer` (`session/di/dependencies.py`, used as `CurrentCustomer`) is the only way an endpoint learns who is calling. It fixes `algorithms=["HS256"]` (so `alg: none` fails), and hands the token to the `TokenVerifier`, which checks the claims above and refuses (401) a `sub` that breaks the id rules. `HTTPBearer(auto_error=False)` keeps Swagger's "Authorize" button and makes a missing header a 401 and not FastAPI's 403. Every failure is `UnauthorizedError`: 401, `WWW-Authenticate: Bearer`, one generic message in the usual `{ "message" }` envelope.
- `customer_id` comes from the token, never the body: `CreateOrderRequest` is `extra="forbid"`, so sending it is a 422. The ownership rule lives in `GetOrder`, and the filter is in the query (`OrderRepository.get_by_id_for_customer`, `WHERE id AND customer_id`), so a foreign order and a missing one cost one query each and can't be told apart by timing: both raise the same `NotFoundError("order not found")` (404, identical body), never 403. `OrderLineRequest` is `extra="forbid"` too.
- `AUTH_TOKEN_SECRET` is mandatory with no default and at least 32 bytes (`EnvConfig` refuses less, so the service doesn't start; it is a `SecretStr`, like `db_password`, and `hide_input_in_errors` keeps it out of validation errors; unwrap it with `.get_secret_value()` only to sign or verify; running `alembic` locally needs it set too). `make env` fills any empty `*_SECRET` of the template with 43 random URL-safe characters and keeps existing values. Rotating it closes every session. Compose guards it as a bare `${AUTH_TOKEN_SECRET:?}` for order-service and assistant-service. Tests generate the secret per test (autouse `auth_secret` fixture: `monkeypatch.setenv` + `get_env_config.cache_clear()`) and sign tokens with the `make_token` fixture; no JWT literal belongs in the repo. The e2e suite gets its session over HTTP (`customer_session` fixture) and the email recipient is `<sub>@example.com`.

### `assistant-service` (TypeScript, ADR-0021)

Same layering and the same rules as the Python services, in `src/features/<feature>/{domain,application/{contracts,usecases,mappers},infrastructure,presentation/{http,consumers}}`; each feature's Nest module is its `di/`. Ports are abstract classes. `domain/` and `application/` never import Prisma, amqplib or Nest.

- ESM (`"type": "module"`, `nodenext`): relative imports end in `.js`. Toolchain is what NestJS CLI 12 generates: Vitest, oxlint, Prettier, TypeScript 6.
- **Contracts:** zod schemas in `src/core/messaging/contracts.ts` mirror `shared/contracts` by hand. Decimals arrive as strings (`"25.50"`) and are stored as `numeric`. The contract tests parse `test/fixtures/contracts/*.json`, exported from the Pydantic models; a contract change needs both the zod edit and regenerated fixtures.
- **Messaging:** `RabbitMQConnection` uses amqplib 2's native recovery (no amqp-connection-manager). Consumers register with `addSetup` from `onModuleInit`, and every setup re-runs on each reconnection (topology, prefetch 10, consume). `/health` reports the broker healthy only after the setups ran. `wrapWithRetry` and `retry-policy.ts` mirror `shared.messaging` by hand: `ZodError`, `InvalidMessageError` and `DomainError` (the `ValueError` equivalent) go to the DLQ, anything else retries. A change to the Python retry protocol has to be ported here; nothing checks it automatically.
- **Persistence:** Prisma 7 (config in `prisma7.config.ts`, generator `prisma-client`, `@prisma/adapter-pg`). The container runs `prisma migrate deploy` before `exec node dist/main.js`, and the test global setup applies the same migrations to a template database that each test file clones. Idempotency is the `order_event_log.event_id` PK (`createMany` with `skipDuplicates`) in the same transaction as the `order_view` change; `order_view.version` is an optimistic lock whose `ConcurrentUpdateError` is transient, so it retries.
- **Out-of-order events** are the domain's job: `OrderView.apply` lets a late `order.created` fill in the details without touching the status, and throws `DomainError` on impossible transitions.
- Integration tests start containers with random passwords. `@testcontainers/rabbitmq` is not used because it hardcodes guest/guest; the test uses `GenericContainer`.
- Like the Python consumers, a duplicate isn't counted in `edo_events_processed_total`.
- **Agent (ADR-0022):** the loop lives in the `AskAssistant` use case; the `LlmClient` port does one turn (tool calls or final text). Caps: 5 turns, 5 tool calls per turn, 30 s per question, 500-character questions. The tools in `application/tools/order-tools.ts` are read-only queries behind the `OrderQueries` port; their JSON Schema comes from zod, and bad arguments go back to the model as `{ error }`. What a tool sends the model is capped (SEC-01), each cap a named constant in `order-tools.ts`: 10 rejection groups and 20 `product_ids` per group (both cut in SQL, in `PrismaOrderViewQueries.rejectionStats`, with `totalRejected` and `totalGroups` computed before the cut) and 20 timeline items; a cut list says `truncated: true` and gives the total (`groups_total` and `items_total` are exact; `product_ids_total` counts distinct products over the group's 1,000 most recent orders, `ROWS_PER_GROUP`, not the whole group). `runTool` replaces any output over `MAX_TOOL_OUTPUT_BYTES` (32 KiB of JSON) with `{ error: "result too large, narrow the query" }` before recording evidence. `customer_id` never reaches the model. The zod contracts bound ids (order-service's pattern, 36 characters), `reason` (200) and `items` (50, equal to order-service's `MAX_ORDER_LINES`; raise both together); `shared/contracts` isn't bounded the same way. `GeminiLlmClient` replays each model turn's original `Content` (`providerData`) so Gemini 3 thought signatures survive, maps a 429 to `LlmQuotaExceededError` (503, no retry loop), and retries a 500 or 503 once after 1 s within the question's time budget. `LLM_PROVIDER=gemini` requires `GEMINI_API_KEY`; `fake` (the default everywhere) needs nothing, and no test uses the network.
- **Grounding (ADR-0025):** citations are built server-side from what the tools returned (`domain/evidence.ts`), never parsed from the model's text. `groundAnswer` replaces any answer that mentions a UUID, an amount or a `SKU-` product ID that no tool returned (and the question didn't contain) with the fixed no-data sentence, outcome `ungrounded`. `Evidence.addValues` records every number and SKU of each tool output; `domain/facts.ts` reads amounts by value in cents (`$1.250`, `1.250,00` and `1250.0` match) and skips plain integers and dates on purpose, so counts never trip it. Before grounding, `AskAssistant` replaces an answer that repeats 8 consecutive words of the system prompt (`domain/prompt-leak.ts`) with the same sentence, outcome `leaked`; the eval's stock case expects `no_data` so it still counts those leaks.
- **Redis (ADR-0023):** one `RedisConnection` (node-redis 6, offline queue off, 1 s command timeout) connects in the background like the broker and shows up as `redis` in `/health`. The ask rate limit (fixed window per IP, `INCR` + `EXPIRE NX` + `TTL` in a `MULTI`; code in `src/core/rate-limit/`) fails closed: Redis down means 503. So does the budget of model calls (ADR-0024, ADR-0026): `AskAssistant` takes one call from the `ModelCallBudget` port before every model turn, and `RedisModelCallBudget` checks and takes from two counters in one Lua script, so a refused call burns nothing: 15 per calendar minute (`LLM_MINUTE_CALL_LIMIT`) and 400 per day (`LLM_DAILY_CALL_LIMIT`), the day keyed by the America/Los_Angeles date because Gemini resets its daily quota at midnight Pacific time. A spent budget, either one, is an `LlmQuotaExceededError` (503). The timeline endpoint has its own per-IP limit (`TIMELINE_RATE_LIMIT_PER_MINUTE`, 120, key prefix `timeline:`) that fails open, and `RedisTimelineCache` does not store an entry over 64 KB of UTF-8. Redis runs `maxmemory-policy volatile-ttl`, so every key the service writes must carry a TTL (a key without one is never evicted and, if they fill memory, makes writes fail and `/ask` return 503); `test/integration/core/redis-keys-have-ttl.spec.ts` checks every write path, so a new Redis key needs its TTL set in the same atomic command. The timeline cache (`TimelineCache` port, `RedisTimelineCache`) fails open and is invalidated by `ProjectOrderEvent` after the commit. An entry is per order AND customer (`order-timeline:<orderId>:customer:<customerId>`, written only from a query already filtered by that customer, so a visitor never reads or writes an entry of someone else's order) and is keyed to a per-order generation counter (`order-timeline:<orderId>:generation`; `invalidate` bumps it and every customer's entry becomes a miss and expires with its TTL) so a read racing an invalidation can't store a stale timeline. Don't replace that with a plain `DEL`.
- `req.ip` drives the rate limit, so `TRUST_PROXY` (`app.setup.ts`) must stay `false` locally and `uniquelocal` behind Caddy in prod; any other value lets clients spoof `X-Forwarded-For` or puts everyone in one bucket.
- **Sessions and scope (ADR-0027, #94):** `SessionAuthGuard` (`src/core/auth/`, `jose`) protects `POST /v1/assistant/ask` and `GET /v1/assistant/orders/{id}/timeline`, and runs BEFORE the rate-limit guard on both (`@UseGuards(SessionAuthGuard, ...)`), so a 401 spends none of the per-IP limit. `/health` and `/metrics` stay open. `verifySessionToken` (`session-token.ts`, pure, no Nest) mirrors order-service's `JwtTokenVerifier`: HS256 only, `iss`, `aud`, `typ`, 30 s of tolerance, required claims `exp iat iss aud sub typ`, `sub` checked with the contracts' `idSchema`. Two `jose` differences are closed by hand: its `typ` option reads the JOSE header (ours is a payload claim, compared in code) and it ignores `iat` unless `maxTokenAge` is set (an `iat` more than 30 s ahead is refused in code; `maxTokenAge` was not used because it would also bound the token's age, which PyJWT does not). Every failure is one 401 with `WWW-Authenticate: Bearer` and `{ "message": "Invalid or missing token" }`. `@CurrentCustomer()` gives the controller the `sub`. `AUTH_TOKEN_SECRET` is mandatory in `env.ts`, at least 32 BYTES (`Buffer.byteLength`), and the validation error never echoes it. The customer is part of every query: `customerId` is required in `OrderViewScope` and in the `OrderQueries` port (`OrderScope`), and it goes into the SQL, `rejectionStats` included, so `totalRejected` and `totalGroups` are per customer. `AskAssistant` takes a `ToolFactory` and builds `buildOrderTools(queries, customerId)` per question; the model never chooses the customer, zod drops any `customer_id` it invents, and none reaches the model. `GetOrderTimeline.execute(orderId, customerId)` asks the cache with the customer and loads with `findTimeline(orderId, customerId)`, a query filtered by `order_id AND customer_id` (one lookup, then the events only if the order is the caller's). A foreign order, a missing one and one whose `order.created` hasn't arrived (no `customer_id` yet) are the same 404 and cost the same: one filtered query, no cache write, so there is no timing oracle (SEC94-01). An id that can't be an order id (`isValidId`: NUL, over 36 characters, a `:`) is a miss before it reaches a cache key or the database, in the use case and in the `get_order_timeline` tool (`{ found: false }`). The Prisma adapters and the use case throw on a missing or empty `customerId` (`assertCustomerId`), because Prisma drops a filter whose value is `undefined` (SEC94-02). `idSchema`, `ID_PATTERN` and `assertCustomerId` live in `src/core/identifiers.ts`. A token's `exp` must be finite and at most 7 days plus 30 s after `iat`. The prompt rule about whose orders the tools see is worded as a description and is longer than `LEAK_WORDS` on purpose (#76, #90). pino-http `redact`s `req.headers.authorization` and `req.headers.cookie`. `order_view` has an index on `(customer_id, last_event_at)`. The CI job `session-token-interop` issues a token with order-service's real `JwtTokenIssuer` (`scripts/ci_issue_session_tokens.py`) and verifies it with the guard's code (`services/assistant-service/ci/verify-session-tokens.ts`), and checks a token signed with another secret is refused. Tests: `TEST_AUTH_SECRET` is generated at import in `test/support/session-token.ts` and `createTestApp` uses it; `signTestToken(customerId, options)` signs by hand so a test can break any claim, and `refusedAuthorizations()` lists every bad header the guard must answer with the same 401. No JWT literal belongs in the repo. The eval asks as `EVAL_CUSTOMER`, who owns every order of its catalog.
- Nest e2e and integration tests build the app with `test/support/test-app.ts` (`createTestApp`), which wires the test Postgres and Redis, lets a test swap the broker or the LLM, and waits for Redis before returning. `randomIp()` gives each test its own rate-limit bucket.

## Conventions

- TDD is a project rule (see the issue template): failing test first. Separate red/green commits per scenario are normal here.
- Conventional Commits in Spanish, with the service as scope (`fix(inventory): ...`, `test(shared): ...`, `docs(adr): ...`). No emojis in code, commits or PRs. Fill in `.github/PULL_REQUEST_TEMPLATE.md` and link the issue (`Closes #N`).
- Architecture decisions go in a new `docs/adr/NNNN-<slug>.md`, in Spanish, using the format in `docs/adr/README.md`, plus a row in its index. Don't rewrite an accepted ADR; supersede it.
- Task scope and checklists live in the GitHub issue (`.github/ISSUE_TEMPLATE/task.md`). Pending work and review findings go in `docs/roadmap.md`. Non-obvious findings that must outlive the task go in the code's docstrings, an ADR or the README.
- The README is the portfolio showcase: update it when behavior, ports, commands or test counts change.
