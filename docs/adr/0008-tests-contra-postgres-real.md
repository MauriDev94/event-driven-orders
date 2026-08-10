# ADR-0008 — Tests de integración contra PostgreSQL real, no SQLite

**Estado:** Aceptada · **Fecha:** 2026-06-09 · **Ámbito:** `order-service`, `inventory-service`

## Contexto

En la primera iteración, los tests de integración de `order-service` corrían contra **SQLite in-memory**: rápido, sin Docker, sin configuración.

El problema es qué se estaba verificando. Las dos garantías centrales del sistema son la idempotencia ([ADR-0006](0006-idempotencia-con-processed-events.md)) y la reserva atómica ([ADR-0007](0007-reserva-de-stock-atomica.md)), y **ambas dependen de comportamiento específico de PostgreSQL**: `INSERT ... ON CONFLICT DO NOTHING`, `FOR UPDATE`, row-level locking real.

SQLite no tiene ese modelo de concurrencia. Un test de race-condition contra SQLite **pasa sin probar nada**: da luz verde a código que se rompe en producción. Es el peor tipo de test — el que da confianza falsa.

## Decisión

Los tests de integración corren contra **PostgreSQL 16 real**:

| Entorno | Mecanismo |
|---|---|
| Local | `PostgresContainer("postgres:16-alpine")` vía `testcontainers` (requiere Docker) |
| CI | Service container PostgreSQL 16 con healthcheck `pg_isready`; el `conftest` detecta `CI=true` |

Los tests de `order-service` que usaban SQLite se retrofitearon a PostgreSQL real.

## Consecuencias

**Positivas**

- Los tests de race-condition e idempotencia **verifican algo real**.
- Se ejercita el mismo esquema Alembic que corre en producción ([ADR-0016](0016-migraciones-alembic-al-arrancar.md)), incluyendo constraints e índices.
- El mismo `conftest` sirve local y en CI.

**Negativas / limitaciones**

- Los tests de integración **requieren Docker** en local.
- La suite es más lenta que con SQLite in-memory (arranque del contenedor).
- Un desarrollador sin Docker no puede correr la suite completa.

Este es además el nivel donde se verifica la idempotencia, en vez de hacerlo desde la suite e2e ([ADR-0018](0018-idempotencia-no-se-verifica-e2e-black-box.md)).
