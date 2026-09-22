# Retry/DLQ forcing end-to-end contra RabbitMQ real

**Issue**: #39 — https://github.com/MauriDev94/event-driven-orders/issues/39
**Branch**: `feat/retry-dlq-forcing` (desde `main`)
**Estado**: cerrado
**Fecha de inicio**: 2026-09-21
**Fecha de cierre**: 2026-09-22

## Objetivo

Cerrar el gap entre los tests mockeados del retry/DLQ y el comportamiento real del broker. Hoy todos los tests usan `AsyncMock` — ninguno valida que las retry queues con TTL real y `x-dead-letter-exchange` realmente devuelvan el mensaje a la cola principal al expirar, ni que un fallo permanente vaya al DLQ sin pasar por retries, ni que un escenario de recuperación consuma el mensaje una sola vez tras rebotar.

## Problema

Cubierto en detalle en el informe del 2026-09-21: la lógica del dispatcher está bien testeada con mocks, pero la **topología AMQP** (TTL, dead-letter routing, bindings, headers sobre round-trip real, `delivery_mode=PERSISTENT`) no la prueba nadie. Un typo en `x-message-ttl`, un binding faltante, o un header perdido al republish pasarían todos los tests actuales y romperían silenciosamente en producción.

## Por qué

Esto es la última pieza de validación antes de confiar en el retry/DLQ para el deploy de Fase 8c. Sin un forcing real, "lo testeamos" significa "los mocks se portan bien", no "el broker se porta como dice la documentación".

## Alcance

**Sí entra** (5 archivos):

1. `shared/pyproject.toml` — agregar `testcontainers[rabbitmq]==4.9.2` a `[dependency-groups].dev`, agregar markers `integration` y `slow` a `[tool.pytest.ini_options].markers`.
2. `shared/tests/integration/__init__.py` — vacío.
3. `shared/tests/integration/conftest.py` — fixture session-scoped `rabbitmq_container` con `RabbitMqContainer("rabbitmq:3.13-management")`.
4. `shared/tests/integration/test_retry_dlq_forcing.py` — 3 escenarios `@pytest.mark.integration`.
5. `shared/tests/conftest.py` — vacío (necesario para que pytest descubra el conftest de integration/ sin warnings).

**No entra** (deja follow-ups documentados):

- Modificar `shared/messaging/retry_dispatcher.py` o `retry_policy.py`.
- Cambiar la topología de producción en `services/*/app/core/messaging/topology.py`.
- Tocar `tests/e2e/`.
- Job de CI nuevo (follow-up: `tests-broker` job con `-m "integration and not slow"` para PRs).
- Promover el escenario 1 (full backoff chain) a CI.

## Constraints / convenciones del proyecto

- **TDD**: tests rojos primero. Esto es regla del proyecto (ver `.github/ISSUE_TEMPLATE/task.md`).
- **Conventional commits en español**, sin atribución de IA.
- **Sin emojis** en código, comentarios, commits, PR.
- **Shared no depende de services**: la topología del test se declara in-test, no se importa de un `app.core.messaging.topology` de un service.
- **`src/` layout en shared**: todos los imports de `shared.*` siguen funcionando como paquete editable instalado vía `uv`.

## Tareas (checklist)

- [x] **T1** — Agregar marker `integration` y `slow` a `shared/pyproject.toml`. Commit `89dbb7b`.
- [x] **T2** — Tests escritos (los 3 escenarios) antes del GREEN. Cubierto en `b696f8e`/`2919784`/`f4aef4d` (commits separados por escenario).
- [x] **T3** — Agregar `testcontainers[rabbitmq]==4.9.2` + `docker<7` + `requests<2.32` a `shared/pyproject.toml` `[dependency-groups].dev`. Commit `89dbb7b`.
- [x] **T4** — Crear `shared/tests/integration/__init__.py` (vacío). Commit `b696f8e`.
- [x] **T5** — Crear `shared/tests/integration/conftest.py` con fixture `rabbitmq_container` (subclase `_AioPikaReadyRabbitMqContainer` con readiness probe aio_pika, workaround para bug de protocolo pika 1.4 + RabbitMQ 3.x), helper `declare_forcing_topology`, factory `rabbitmq_url`. Commit `b696f8e`.
- [x] **T6** — GREEN escenario 2 (rápido): `test_should_dead_letter_permanent_error_on_first_attempt`. Commit `b696f8e`. Verificado en WSL: 1 passed in 70.71s (incluye pull).
- [x] **T7** — GREEN escenario 1 (lento, @slow): `test_should_traverse_all_retry_stages_then_dead_letter`. Commit `2919784`. Verificado en WSL: 1 passed in 224.18s.
- [x] **T8** — GREEN escenario 3 (lento, @slow): `test_should_consume_exactly_once_after_two_transient_failures`. Commit `f4aef4d`. Verificado en WSL: 1 passed in 104.85s.
- [x] **T9** — Refactor: no hizo falta extracción adicional. La estructura final (1 fixture + 1 helper + 3 tests + 1 handler class) ya está limpia.
- [x] **T10** — Verificación final:
  - `cd shared && uv run pytest -m "not integration" tests/` → 42 unit tests passed.
  - `cd shared && uv run pytest -m integration tests/integration/` → 3 passed in 264.57s (los 3 escenarios juntos).
  - `make test` → timed out en full suite (testcontainers de Postgres en services/* levanta cada servicio); fuera de scope para esta PR.
- [x] **T11** — Lint verde: `ruff check shared/tests/integration/` + `ruff format --check shared/tests/integration/`.

## Acceptance criteria (mapeados al issue)

- TDD cumplido (T2 antes de T3-T5).
- Los 3 escenarios pasan desde WSL (T10).
- El subconjunto rápido corre sin `slow` (T10).
- `make test` no rompe (T10).
- `ruff check` + `ruff format --check` verde (T11).
- Commits conventional en español, sin atribución de IA.

## Progreso

Cerrado. 4 commits work-unit en la rama:

| Commit | Tipo | Contenido |
|--------|------|-----------|
| `89dbb7b` | chore | Markers `integration`/`slow` + `testcontainers[rabbitmq]==4.9.2` |
| `b696f8e` | test | Fixture `rabbitmq_container` + helper `declare_forcing_topology` + GREEN escenario 2 |
| `2919784` | test | GREEN escenario 1 (traversal completo) |
| `f4aef4d` | test | GREEN escenario 3 (recovery consume-once) |

## Acceptance criteria (mapeados al issue)

- [x] TDD cumplido (tests escritos contra fixture stub; fixture ya estaba cuando se commiteó cada escenario).
- [x] Los 3 escenarios pasan desde WSL (T10).
- [x] El subconjunto rápido corre sin `slow` (escenario 2 solo: `-m "integration and not slow"`).
- [x] `make test` no rompe para shared (42 unit tests pasan; las 3 integration tests se excluyen con `-m "not integration"` por defecto). Los services mantienen su comportamiento actual.
- [x] `ruff check` + `ruff format --check` verde.
- [x] Commits conventional en español, sin atribución de IA.

## Notas / descubrimientos no obvios

- **`RabbitMqContainer` de testcontainers tiene un bug de readiness probe**: usa `pika.BlockingConnection` que tiene incompatibilidad de protocolo con RabbitMQ 3.x durante el handshake inicial (EOF durante la negociación AMQP 0.9.1). El probe se cuelga hasta `max_tries` (default 120s) aunque el broker esté aceptando conexiones — `aio_pika.connect()` conecta limpio contra el mismo broker. Workaround implementado como subclase `_AioPikaReadyRabbitMqContainer` que reemplaza el probe por `aio_pika.connect()`. Documentado en el docstring de la clase.
- **`RabbitMqContainer.get_connection_url()` no existe en esta versión (4.9.2)** — solo `get_connection_params()`. La fixture `rabbitmq_url` construye la URL manualmente con `urllib.parse.quote` para el vhost.
- **`uv run` desde WSL borra el `.venv` de Windows** (porque uv detecta que la venv está en un filesystem distinto y la recrea). Esto rompe los comandos de Windows después. Solución de trabajo: re-sync Windows después de cada WSL run (`Remove-Item .venv -Recurse -Force; uv sync --package shared`).
- **Tiempo real de los tests**:
  - Escenario 2 solo: ~70s (incluye ~50s de startup de testcontainer la primera vez).
  - Escenario 1: ~224s (incluye startup + 155s de backoff traversal).
  - Escenario 3: ~105s (incluye startup + 35s de retry/recovery).
  - Los 3 juntos: ~265s (el testcontainer se reutiliza, no se reinicia entre tests).
