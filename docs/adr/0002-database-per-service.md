# ADR-0002 — Database-per-service

**Estado:** Aceptada · **Fecha:** 2026-06-07 · **Ámbito:** `order-service`, `inventory-service`, `notification-service`

## Contexto

Con tres servicios existe la tentación de compartir una sola base de datos: es más barato de operar y permite joins entre órdenes y productos. Pero una base compartida convierte el esquema en una interfaz pública implícita — cualquier servicio puede leer (y acoplarse a) las tablas de otro, y ninguna migración se puede hacer sin coordinar a todos.

## Decisión

Cada servicio es dueño exclusivo de su esquema:

| Servicio | Base de datos |
|---|---|
| `order-service` | PostgreSQL propio (`localhost:5433` en dev) |
| `inventory-service` | PostgreSQL propio (`localhost:5434` en dev) |
| `notification-service` | **Sin base de datos** — consumer puro ([ADR-0009](0009-notification-service-sin-base-de-datos.md)) |

La única integración entre servicios son los eventos ([ADR-0001](0001-comunicacion-asincrona-por-eventos.md)).

## Consecuencias

**Positivas**

- Cada servicio migra su esquema sin coordinar con nadie ([ADR-0016](0016-migraciones-alembic-al-arrancar.md)).
- Es imposible acoplarse por la base de datos: el único contrato es el evento.
- El aislamiento es real, no una convención que alguien puede saltarse.

**Negativas / limitaciones**

- No hay joins entre servicios; cualquier vista combinada hay que componerla desde los eventos.
- Dos contenedores PostgreSQL en lugar de uno.
- Los tests e2e no pueden inspeccionar el estado interno de otro servicio sin romper el aislamiento. Por eso la idempotencia se verifica a nivel de integración, con acceso directo a la base del servicio bajo prueba, y no como test e2e black-box ([ADR-0018](0018-idempotencia-no-se-verifica-e2e-black-box.md)).
