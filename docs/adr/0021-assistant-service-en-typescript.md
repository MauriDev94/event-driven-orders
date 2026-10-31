# ADR-0021 — `assistant-service` en TypeScript/NestJS: el contrato es el JSON en el cable

**Estado:** Aceptada · **Fecha:** 2026-10-31 · **Ámbito:** `assistant-service`, `scripts/export_contract_fixtures.py`, CI

## Contexto

El paso 3 del [roadmap](../roadmap.md) suma un cuarto servicio, `assistant-service` ([plan](../plan-assistant-service.md)). Proyecta los cinco eventos del flujo en un read model propio y, en la fase C, va a exponer un asistente con IA sobre ese read model. Se escribe en **TypeScript con NestJS** a propósito: un consumidor en otro stack prueba que el contrato entre servicios es el JSON que viaja por RabbitMQ y no el código Python de `shared/`.

Ese objetivo choca con lo que `shared/` resuelve para los servicios Python, porque TypeScript no puede importarlo:

- **Contratos.** [ADR-0003](0003-shared-contratos-e-infraestructura-transversal.md) los define como modelos Pydantic en `shared/contracts`. Una copia a mano en otro lenguaje puede desviarse sin que nadie lo note.
- **Protocolo de reintentos.** El header `x-retry-count`, las colas TTL `retry-5s|30s|2m`, la DLQ por el exchange por defecto y la clasificación de errores permanentes ([ADR-0011](0011-retry-con-backoff-y-dlq.md)) viven en `shared.messaging`.
- **Reconexión.** Los servicios Python usan la `RobustConnection` de aio-pika más un watchdog ([ADR-0013](0013-resiliencia-de-conexion-al-broker.md)).

Además, las opciones obvias del ecosistema Node no calzan:

- El transporte RMQ de `@nestjs/microservices` espera mensajes con forma `{ pattern, data }`, declara sus colas a su manera y no tiene colas de reintento con TTL. Los eventos del sistema son JSON crudos con la routing key igual a `event_type`.
- El plan proponía `amqp-connection-manager` para reconectar, pero `amqplib` 2 ya trae recovery propio (opción `recovery` de `connect`), con un callback `setup` que se vuelve a ejecutar en cada reconexión.
- Al empezar (2026-10-31), npm marcaba como `latest` una release candidate de Prisma 8, y la guía de NestJS de Prisma ya describía esa versión.

## Decisión

**1. El contrato es el JSON en el cable, verificado contra Pydantic.**

- Esquemas zod en `src/core/messaging/contracts.ts`, espejo de `shared/contracts`: los campos de `BaseEvent` más los cinco eventos, en una unión discriminada por `event_type`. Los decimales (`total_amount`, `unit_price`) llegan como string, porque Pydantic v2 serializa `Decimal` como texto, y se guardan como `numeric`.
- `scripts/export_contract_fixtures.py` genera un JSON por evento desde los modelos Pydantic en `services/assistant-service/test/fixtures/contracts/`, y los tests de contrato los parsean con zod.
- CI corre el script con `--check`: si un contrato de Python cambia y los fixtures no se regeneraron, el job falla; si se regeneraron y zod no los acepta, fallan los tests. `shared/` no cambia; el script solo lo lee.

**2. Mensajería con `amqplib` directo, mismo protocolo que los servicios Python.**

- `RabbitMQConnection` usa el recovery nativo de `amqplib` 2: `waitForConnect: false`, para que el arranque no espere al broker, y backoff de 1 s a 30 s. En cada (re)conexión abre un canal y ejecuta los `setup` registrados (declarar la topología, prefetch 10, consumir). `/health` informa `broker: healthy` solo cuando esos `setup` terminaron en la conexión actual.
- `retry-policy.ts` y `retry-dispatcher.ts` portan `shared.messaging`: el mismo header, las mismas etapas (5.000, 30.000 y 120.000 ms), 3 reintentos y luego DLQ, ACK del original al republicar. Son errores permanentes un `ZodError`, un `InvalidMessageError` (cuerpo que no es JSON) y un `DomainError`, el equivalente del `ValueError` de los servicios Python. Todo lo demás es transitorio.
- La cola `assistant-service.order-events` se enlaza a las cinco routing keys de forma explícita, sin comodín: un evento nuevo no llega a un servicio que no sabe procesarlo.
- Mismas métricas (`edo_events_processed_total`, `edo_events_dlq_total`, `edo_events_retried_total`, `edo_event_processing_seconds`, con las mismas etiquetas) y logs JSON con `correlation_id` ([ADR-0012](0012-logging-json-y-correlation-id.md)), para que Grafana y la operación de la DLQ no distingan el lenguaje.

**3. Persistencia con Prisma 7, la última versión estable.**

- Prisma 7.10 con el generador `prisma-client` (ESM, cliente generado en `src/generated/`, fuera de git), el driver adapter `@prisma/adapter-pg` y la configuración en `prisma7.config.ts`.
- El contenedor corre `prisma migrate deploy` antes de arrancar, como Alembic en [ADR-0016](0016-migraciones-alembic-al-arrancar.md). Por eso `prisma` es una dependencia de runtime.
- Idempotencia como en [ADR-0006](0006-idempotencia-con-processed-events.md): `order_event_log` tiene `event_id` como PK y el insert es `ON CONFLICT DO NOTHING` (`createMany` con `skipDuplicates`), en la misma transacción que el cambio en `order_view`. Si no insertó nada, el evento es un duplicado y se hace ACK sin efectos.
- `order_view` tiene una columna `version` (lock optimista). Si dos eventos del mismo pedido se proyectan a la vez, el segundo lanza `ConcurrentUpdateError`, que es transitorio y vuelve por `retry-5s`. Los eventos fuera de orden los resuelve la entidad `OrderView` en el dominio.

**4. La toolchain es la que genera el CLI de NestJS 12:** ESM, Vitest, oxlint con reglas que usan tipos, Prettier y TypeScript estricto. El plan decía Jest y ESLint, pero también decía usar lo que genera el CLI. Los tests de integración corren contra Postgres y RabbitMQ reales ([ADR-0008](0008-tests-contra-postgres-real.md)): testcontainers en local, el Postgres del job en CI.

**5. El servicio queda fuera del workspace de uv** (`exclude` en el `pyproject.toml` raíz), con su `package.json` y `package-lock.json`. El `Makefile` suma pasos con `npm` a `install`, `lint`, `test` y `format`, y CI tiene un job propio con Node 24.

## Consecuencias

**Positivas**

- El sistema prueba que sus contratos no dependen del lenguaje, y la deriva entre Pydantic y zod no puede llegar a `main` sin que falle CI.
- Para operar, el servicio nuevo se ve igual que los otros: las mismas colas `retry-*` y `.dlq`, las mismas métricas, `/health` siempre 200 ([ADR-0014](0014-health-siempre-200.md)) y la reconexión sola tras reiniciar RabbitMQ.
- Una dependencia menos (`amqp-connection-manager`), y ninguna abstracción entre el código y el protocolo AMQP, que se necesita controlar exacto.

**Negativas / limitaciones**

- **Dos toolchains** en CI y en local: uv y Python 3.12 por un lado, Node 24 y npm por el otro.
- **El protocolo de reintentos está duplicado en dos lenguajes.** A diferencia de los contratos, no hay un chequeo automático: un cambio en `shared.messaging.retry_policy` hay que portarlo a mano a `retry-policy.ts`.
- **Los fixtures cubren un ejemplo por evento.** Si un campo opcional falta en el fixture, una diferencia en ese campo no se detecta.
- **La imagen pesa ~860 MB**, porque el CLI de Prisma y sus dependencias viajan en el runtime para correr `migrate deploy`. Se podría separar la migración en un contenedor aparte; por ahora se acepta, igual que Alembic en los servicios Python.
- **El lock optimista cambia contención por latencia:** con prefetch 10, dos eventos del mismo pedido que llegan juntos hacen que uno espere 5 s en `retry-5s`. Con el volumen del proyecto es raro, y nunca deja el read model inconsistente.

## Alternativas

**El transporte RMQ de `@nestjs/microservices`.** Envuelve los mensajes en `{ pattern, data }`, no declara colas de reintento con TTL y no deja leer ni escribir `x-retry-count` como lo hacen los servicios Python. Habría que cambiar el formato de los eventos o pelear con el framework. Descartado.

**`amqplib` con `amqp-connection-manager`**, como proponía el plan. Era la forma clásica de reconectar con `amqplib` 0.x; la versión 2 trae el mismo comportamiento (reconexión con backoff y `setup` repetido en cada conexión) sin una dependencia extra. Descartado.

**Generar los esquemas zod desde el JSON Schema de Pydantic.** Elimina la copia a mano, pero agrega un paso de generación de código y deja fuera reglas que el JSON Schema no expresa igual (el formato de los decimales, la unión discriminada). Con cinco eventos, la copia a mano más los fixtures es más simple. Se descarta por ahora; si los contratos crecen, vale la pena revisarlo.

**Prisma 8.** Al empezar era una release candidate. Se eligió la última 7.x estable; migrar a la 8 cuando salga estable queda como mejora.

**Jest y ESLint**, como decía el plan. El CLI de NestJS 12 genera Vitest y oxlint, y mantener lo que genera el CLI simplifica actualizarlo. Descartado.
