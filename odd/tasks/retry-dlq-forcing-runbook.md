# Cómo correr los forcing tests

Los 3 forcing tests del retry/DLQ viven en `shared/tests/integration/` y
requieren un broker RabbitMQ real accesible desde la sesión donde se
ejecutan. En este repo se levanta con `testcontainers[rabbitmq]` y un
Docker daemon — el setup recomendado es WSL con el venv `.wsl-venv`
(opción C de la sesión 2026-09-11).

## Setup

Desde WSL Ubuntu, con la rama `feat/retry-dlq-forcing` ya sincronizada:

```bash
export PATH=$HOME/.local/bin:$PATH
cd /mnt/d/Proyectos/python/clean/event-driven-orders
uv sync --package shared
```

El primer `uv sync` descarga `testcontainers`, `pika`, el `docker` SDK y
los pins de compatibilidad (`docker<7`, `requests<2.32`). Las corridas
siguientes son incrementales.

Docker debe estar accesible desde WSL (este repo ya validó la cadena con
`PostgresContainer` en sesiones anteriores).

## Comandos

| Quiere correr | Comando |
|---------------|---------|
| Los 3 escenarios (full suite, ~4m) | `cd shared && uv run pytest -m integration tests/integration/test_retry_dlq_forcing.py` |
| Solo el escenario rápido (DLQ en permanent failure, ~5s tras startup) | `cd shared && uv run pytest -m "integration and not slow" tests/integration/test_retry_dlq_forcing.py` |
| Solo el escenario 1 (traversal completo) | `cd shared && uv run pytest -m slow tests/integration/test_retry_dlq_forcing.py::test_should_traverse_all_retry_stages_then_dead_letter` |
| Solo el escenario 3 (recovery) | `cd shared && uv run pytest -m slow tests/integration/test_retry_dlq_forcing.py::test_should_consume_exactly_once_after_two_transient_failures` |

El primer test de la sesión paga el costo de levantar el contenedor
(`rabbitmq:3.13-management`, ~50-90s la primera vez, ~5s en corridas
sucesivas mientras el contenedor siga en el daemon de Docker). Los
siguientes tests reusan el mismo container.

## Lint

Desde Windows o WSL:

```bash
uv run --package shared ruff check shared/tests/integration/
uv run --package shared ruff format --check shared/tests/integration/
```

## Limitaciones conocidas

- **No incluido en CI todavía**. El job de CI que los correría sería un
  follow-up: agregarlo como nuevo job `tests-broker` en
  `.github/workflows/ci.yml`, con `-m "integration and not slow"` para que
  PRs ejecuten solo el escenario 2 (rápido). El escenario 1 y 3 quedan
  como promoción a `main` o a un workflow manual.
- **El venv `.venv` se rompe entre sesiones Windows y WSL**: `uv` desde
  WSL detecta el filesystem distinto y recrea el `.venv`, dejando el
  estado de Windows inconsistente. Después de correr tests en WSL,
  re-sync desde Windows con `Remove-Item .venv -Recurse -Force; uv sync
  --package shared`.
