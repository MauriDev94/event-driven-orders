# ADR-0016 — Migraciones con Alembic ejecutadas al arrancar el contenedor

**Estado:** Aceptada · **Fecha:** 2026-06-08 · **Ámbito:** `order-service`, `inventory-service`

## Contexto

`order-service` e `inventory-service` son dueños exclusivos de su esquema ([ADR-0002](0002-database-per-service.md)) y ese esquema evoluciona: `processed_events` ([ADR-0006](0006-idempotencia-con-processed-events.md)) se agregó después de las tablas iniciales.

Alguien tiene que aplicar las migraciones antes de que el servicio atienda tráfico. Si es un paso manual de deploy, tarde o temprano se olvida y el servicio arranca contra un esquema viejo.

Además, `inventory-service` no sirve para nada sin catálogo: probar el flujo requeriría insertar productos a mano cada vez que se levanta el stack.

## Decisión

**Alembic por servicio.** El `env.py` resuelve la URL desde `DATABASE_URL` o desde las variables `db_*`.

**El contenedor corre `alembic upgrade head` al arrancar.** No hay paso manual.

**La migración inicial de `inventory-service` siembra el catálogo** (`SKU-001` … `SKU-005`, con stocks de 100 a 5), para que el flujo end-to-end sea ejercitable inmediatamente después de `make up`.

## Consecuencias

**Positivas**

- El esquema está siempre al día sin paso manual de deploy.
- El seed permite probar el flujo — y correr los tests e2e — sin cargar datos a mano.
- Los tests de integración corren contra el **mismo** esquema migrado que producción ([ADR-0008](0008-tests-contra-postgres-real.md)).

**Negativas / limitaciones**

- Con N réplicas del mismo servicio, todas intentan migrar al arrancar. Alembic toma un lock, así que es seguro, pero es una carrera innecesaria.
- Una migración que falla **impide el arranque** del servicio.
- El catálogo seed vive en una migración: es data de demo mezclada con la evolución del esquema, y en un despliegue real habría que separarla.
