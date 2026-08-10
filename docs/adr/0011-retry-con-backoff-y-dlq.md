# ADR-0011 — Retry con backoff de 3 etapas + DLQ vía colas TTL y exchange por defecto

**Estado:** Aceptada · **Fecha:** 2026-06-10 · **Ámbito:** los 3 servicios

## Contexto

Un consumer falla por dos razones distintas y hay que tratarlas distinto:

- **Transitorias**: PostgreSQL reiniciándose, SMTP que no responde, red intermitente. Reintentar funciona.
- **Permanentes**: payload malformado, `event_type` desconocido. Reintentar **nunca** va a funcionar.

Sin esa distinción hay dos fallas simétricas: un `nack(requeue=True)` sobre un payload malformado genera un **loop infinito** que satura el consumer; un `nack(requeue=False)` sobre una caída temporal **pierde el mensaje**.

Además, RabbitMQ no ofrece *delayed retry* nativo sin el plugin `rabbitmq_delayed_message_exchange` — que obliga a instalar y mantener un plugin en el broker.

## Decisión

### Implementación única en `shared/messaging/`

| Módulo | Responsabilidad |
|---|---|
| `retry_policy.py` | Clasificación del error y decisión retry/DLQ — **función pura**, testeable sin broker |
| `retry_dispatcher.py` | `wrap_with_retry` — *side-effecting*: ack / nack / republish |

Se implementa una vez y la reusan los tres servicios ([ADR-0003](0003-shared-contratos-e-infraestructura-transversal.md)).

### Backoff de 3 etapas sin plugins

Por cada cola principal `<queue>` se declaran tres colas de espera:

| Cola | TTL |
|---|---|
| `<queue>.retry-5s` | 5 s |
| `<queue>.retry-30s` | 30 s |
| `<queue>.retry-2m` | 120 s |

Cada una con `x-dead-letter-exchange: ""` y `x-dead-letter-routing-key: <queue>`. **Al expirar el TTL, el mensaje vuelve solo a la cola principal.** El broker hace el trabajo de temporización; no hay scheduler propio. `MAX_RETRIES = 3`.

### Contador de intentos en el header `x-retry-count`

- Fallo **TRANSIENT** con reintentos disponibles → republicar a `<queue>.retry-{etapa}` con `x-retry-count` incrementado y ACKear el original.
- **PERMANENT**, o reintentos agotados → `nack(requeue=False)` → `<queue>.dlq`.

### Clasificación transient vs. permanent

| Excepción | Clasificación |
|---|---|
| `pydantic.ValidationError`, `json.JSONDecodeError`, `ValueError` | **PERMANENT** → DLQ inmediato |
| Cualquier otra (PostgreSQL/SMTP caídos, red) | **TRANSIENT** → backoff |

## Nota de implementación — el DLQ "fantasma"

Antes de esta decisión, las tres colas principales declaraban `x-dead-letter-exchange: "orders.dlx"`: un exchange *topic* que **nunca se declaró ni se bindeó**. Cualquier `nack(requeue=False)` **perdía el mensaje en silencio** — sin error, sin log, sin cola donde buscarlo.

Se corrigió usando el **exchange por defecto** (`""`) más `x-dead-letter-routing-key: <queue>.dlq`, que enruta directo a la cola por nombre y no depende de ningún binding. Cubierto por `tests/integration/test_topology.py` en los tres servicios.

## Consecuencias

**Positivas**

- Backoff real sin depender de plugins del broker.
- Los errores permanentes no consumen reintentos ni tiempo.
- Los reintentos son seguros gracias a la idempotencia ([ADR-0006](0006-idempotencia-con-processed-events.md), [ADR-0009](0009-notification-service-sin-base-de-datos.md)).
- La topología es verificable con un test de integración.

**Negativas / limitaciones**

- La topología crece: **4 colas extra por cada cola principal** (3 de retry + 1 DLQ).
- Republicar y ACKear el original **no son atómicas**: una caída entre ambas operaciones puede duplicar el mensaje (cubierto por idempotencia) o perderlo.
- Las DLQ hay que inspeccionarlas a mano: RabbitMQ Management → *Queues* → `<service>.<queue>.dlq`; el botón *Get messages* muestra el body y los headers `x-retry-count` / `x-death`. No hay alerta automática.
