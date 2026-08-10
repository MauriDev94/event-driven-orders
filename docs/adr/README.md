# Architecture Decision Records

Registro de las decisiones de arquitectura de **Event-Driven Orders**. Una decisión por archivo, con el contexto que la motivó, las alternativas evaluadas y sus consecuencias — **incluidas las limitaciones aceptadas**.

Un ADR no se reescribe cuando la realidad cambia: se marca como `Superseded by ADR-XXXX` y se escribe uno nuevo. El historial de por qué se decidió algo es tan valioso como la decisión misma.

## Índice

### Fundacionales

| ADR | Decisión | Estado |
|---|---|---|
| [0001](0001-comunicacion-asincrona-por-eventos.md) | Comunicación exclusiva por eventos y eventual consistency | Aceptada |
| [0002](0002-database-per-service.md) | Database-per-service | Aceptada |
| [0003](0003-shared-contratos-e-infraestructura-transversal.md) | `shared/` como fuente única de contratos e infraestructura transversal | Aceptada |
| [0004](0004-puertos-en-application-adapters-en-presentation.md) | Puertos en `application/`, adapters en `presentation/` e `infrastructure/` | Aceptada |

### Consistencia y persistencia

| ADR | Decisión | Estado |
|---|---|---|
| [0005](0005-publish-after-commit-en-vez-de-outbox.md) | Publish-after-commit en vez de outbox transaccional | Aceptada (MVP) |
| [0006](0006-idempotencia-con-processed-events.md) | Idempotencia vía `processed_events` en la misma transacción | Aceptada |
| [0007](0007-reserva-de-stock-atomica.md) | Reserva de stock atómica con `UPDATE` condicional + `SAVEPOINT` | Aceptada |
| [0016](0016-migraciones-alembic-al-arrancar.md) | Migraciones con Alembic ejecutadas al arrancar el contenedor | Aceptada |

### Mensajería y resiliencia

| ADR | Decisión | Estado |
|---|---|---|
| [0011](0011-retry-con-backoff-y-dlq.md) | Retry con backoff de 3 etapas + DLQ vía colas TTL y exchange por defecto | Aceptada |
| [0013](0013-resiliencia-de-conexion-al-broker.md) | Resiliencia de conexión al broker: retry en cold start + watchdog | Aceptada |

### Observabilidad y operación

| ADR | Decisión | Estado |
|---|---|---|
| [0012](0012-logging-json-y-correlation-id.md) | Logging JSON estructurado + correlation ID end-to-end | Aceptada |
| [0014](0014-health-siempre-200.md) | `/health` siempre responde 200, con el estado de dependencias en el body | Aceptada |

### `notification-service`

| ADR | Decisión | Estado |
|---|---|---|
| [0009](0009-notification-service-sin-base-de-datos.md) | `notification-service` sin base de datos: deduplicación en memoria | Aceptada (MVP) |
| [0010](0010-email-derivado-del-customer-id.md) | Email del destinatario derivado del `customer_id` | Aceptada (MVP) |

### Testing y build

| ADR | Decisión | Estado |
|---|---|---|
| [0008](0008-tests-contra-postgres-real.md) | Tests de integración contra PostgreSQL real, no SQLite | Aceptada |
| [0017](0017-tests-e2e-solo-local-no-en-ci.md) | Los tests e2e corren solo en local, no en CI | Aceptada |
| [0018](0018-idempotencia-no-se-verifica-e2e-black-box.md) | La idempotencia no se verifica con un test e2e black-box | Aceptada |
| [0015](0015-build-context-en-la-raiz.md) | Build context en la raíz del repo y dependencias por servicio | Aceptada |

## Formato

Cada ADR sigue la misma estructura:

```markdown
# ADR-XXXX — Título en una línea

**Estado:** Aceptada | Aceptada (MVP) | Superseded by ADR-YYYY · **Fecha:** YYYY-MM-DD · **Ámbito:** servicios afectados

## Contexto      ← el problema y por qué la solución obvia no sirve
## Decisión      ← qué se hizo, con el detalle técnico
## Consecuencias ← positivas y, sobre todo, negativas/limitaciones aceptadas
## Alternativas  ← qué más se evaluó y por qué se descartó (cuando aplica)
```

Para agregar uno nuevo: siguiente número correlativo, mismo formato, y una fila en el índice de arriba.
