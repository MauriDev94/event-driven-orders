# ADR-0017 — Los tests e2e corren solo en local, no en CI

**Estado:** Aceptada · **Fecha:** 2026-06-11 · **Ámbito:** `tests/e2e/`, `.github/workflows/ci.yml`

## Contexto

La suite `tests/e2e/` ejercita el **stack real completo** —RabbitMQ, dos PostgreSQL, Mailhog y los tres servicios— levantado con `make up`, sin mocks ni dependency overrides. Observa el resultado únicamente a través de fronteras públicas: la API HTTP de `order-service` y la API de Mailhog (`/api/v2/messages`).

Lo natural sería correrla en cada push. El problema es lo que eso cuesta y lo que realmente aporta:

- Hay que **levantar y buildear cinco contenedores** en cada ejecución del pipeline.
- Los runners compartidos de GitHub Actions tienen **tiempos de arranque variables**: un stack que localmente sube en 20 s puede tardar el triple, y los timeouts de polling empiezan a fallar por razones que no tienen nada que ver con el código.
- Un test e2e flaky es peor que no tenerlo: entrena al equipo a re-lanzar el job en vez de leer el fallo.

Y sobre la señal que aportaría: los gates de calidad **por servicio** (`quality` con ruff/mypy, más `tests-db` / `tests` con cobertura contra PostgreSQL real) ya corren en cada push y en cada PR. El e2e no agrega información sobre un PR individual que esos gates no den antes y más rápido.

## Decisión

**Los tests e2e no corren en CI.** Están marcados con `@pytest.mark.e2e` y se ejecutan con `make e2e` contra un stack levantado a mano con `make up`.

Su rol es **verificación pre-PR y smoke test de release**, no gate por commit.

CI mantiene:

| Job | Qué corre |
|---|---|
| `quality` (matrix × 3) | `ruff check` + `ruff format --check` + `mypy app` |
| `quality-shared` | `ruff check` + `ruff format --check` sobre `shared/` |
| `tests-db` (order, inventory) | `pytest` con cobertura sobre PostgreSQL 16 efímero |
| `tests` (notification) | `pytest` con cobertura, sin base de datos |

## Consecuencias

**Positivas**

- El pipeline se mantiene rápido y determinista: los fallos de CI significan algo.
- Sin infraestructura de cinco contenedores que mantener en el workflow.
- La suite e2e puede tomarse el tiempo que necesite (polling con timeout) sin presionar el tiempo de CI.

**Negativas / limitaciones**

- **Nada obliga a correr el e2e.** Depende de disciplina: si nadie ejecuta `make e2e` antes de abrir el PR, una regresión de integración llega a `main`.
- Los tests e2e pueden pudrirse en silencio: si el stack cambia y nadie los corre, se descubre tarde.
- Correrlos requiere Docker local, igual que los tests de integración ([ADR-0008](0008-tests-contra-postgres-real.md)).

## Alternativas

**Correrlos solo en `main` o en un job nocturno.** Recupera la ejecución automática sin castigar cada PR, y es el paso natural si el proyecto crece. No se implementó en el MVP porque el ciclo de trabajo actual (un solo autor, `make e2e` antes de cada PR) lo hace redundante.
