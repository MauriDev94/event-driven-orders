# ADR-0023 — Redis para el rate limit del asistente (falla cerrado) y una caché invalidada por eventos (falla abierta)

**Estado:** Aceptada · **Fecha:** 2026-10-31 · **Ámbito:** `assistant-service`, `docker-compose*.yml`

## Contexto

La fase D del [plan](../plan-assistant-service.md) suma Redis al `assistant-service` para dos cosas:

1. **Proteger la cuota gratis de Gemini.** Cada pregunta a `POST /v1/assistant/ask` puede hacer hasta 5 llamadas al modelo ([ADR-0022](0022-asistente-con-agente-y-herramientas-de-solo-lectura.md)), y el plan gratis tiene límites por minuto y por día. Sin un límite propio, cualquiera que encuentre el endpoint la agota.
2. **Una caché del timeline.** `GET /v1/assistant/orders/{id}/timeline` y la herramienta `get_order_timeline` leen lo mismo. Un evento nuevo del pedido tiene que verse al instante, no después de un TTL.

Las dos necesidades tratan distinto una caída de Redis: si el rate limit no puede contar, dejar pasar las preguntas expone la cuota; si la caché no responde, alcanza con leer de Postgres.

## Decisión

**1. Un Redis 8.8 sin persistencia, compartido por las dos funciones.**

- Corre sin RDB ni AOF: contadores y entradas de caché se pueden perder en un reinicio sin consecuencias. Tiene `maxmemory 64mb` con `allkeys-lru`.
- Tiene contraseña (`REDIS_PASSWORD`, generada por `make env` como las demás) y en producción no publica puertos.
- `RedisConnection` usa node-redis 6 con la cola offline desactivada: mientras Redis no está, cada comando falla al instante, en vez de esperar la reconexión. Los comandos tienen un timeout de 1 s.
- Como con el broker, conectarse nunca bloquea el arranque. node-redis reintenta con backoff (de 1 s a 30 s), y `/health` informa `redis: unhealthy` mientras tanto ([ADR-0014](0014-health-siempre-200.md)).

**2. Rate limit de ventana fija por IP, que falla cerrado.**

- `INCR`, `EXPIRE … NX` y `TTL` van en un mismo `MULTI`. La primera pregunta de la ventana fija la expiración, y una caída entre los dos comandos no deja un contador sin expiración que bloquee la IP para siempre.
- El límite es de 5 preguntas por minuto (`ASK_RATE_LIMIT_PER_MINUTE`). Al pasarse, responde 429 con `Retry-After`. Es un guard de Nest que corre antes de validar el body y de llamar al modelo.
- Si Redis no responde, la pregunta recibe 503: falla cerrado, porque el límite existe para cuidar la cuota.
- La IP sale de `req.ip`. Express la toma de `X-Forwarded-For` solo si la conexión viene de un proxy de confianza (`TRUST_PROXY`). En desarrollo es `false`: vale la dirección del socket, la del gateway de Docker. En producción es `uniquelocal`, la IP privada de Caddy en `edo_net`.

**3. Caché del timeline (cache-aside), invalidada por los eventos y que falla abierta.**

- El puerto `TimelineCache.getOrLoad(orderId, load)` vive en `order-history/application`. Lo usa `GetOrderTimeline`, que comparten el endpoint y la herramienta del asistente. Un pedido desconocido no se guarda: su primer evento puede estar en camino.
- `ProjectOrderEvent` invalida la entrada después del commit, y solo si el evento se proyectó. Un duplicado o una proyección fallida no la tocan.
- **Un contador de generación por pedido evita una carrera.** Con un simple "borrar al escribir", una lectura podría leer el estado viejo de Postgres, la proyección hacer commit y borrar la clave, y la lectura guardar después el estado viejo por un TTL entero.
  - Cada invalidación hace `INCR` de `order-timeline:{id}:generation` (en un `MULTI` con el `DEL` de la entrada).
  - Cada lectura guarda la generación que vio antes de cargar.
  - Al leer, una entrada con una generación que ya no es la actual cuenta como fallo de caché.
  - El contador vive 10 veces el TTL de las entradas, así que cuando expira no puede quedar ninguna entrada que coincida con un contador recién creado.
- El TTL de las entradas es de 60 s. Si Redis falla al leer, escribir o invalidar, se registra un warning y se lee de Postgres (falla abierta). El TTL acota cuánto puede durar una entrada vieja si se pierde una invalidación.

## Consecuencias

**Positivas**

- La cuota del modelo queda protegida aunque se caiga Redis, y el resto del servicio (proyección, timeline, health) sigue andando sin Redis.
- Un evento se ve en el timeline en la lectura siguiente; lo prueban el e2e de Nest y el `make e2e`, que consulta el timeline hasta ver los tres eventos con la caché encendida.
- La carrera de la invalidación tiene un test propio contra Redis real.

**Negativas / limitaciones**

- **La ventana fija permite ráfagas en el borde:** hasta el doble del límite en dos segundos, al final de una ventana y al comienzo de la siguiente. Para proteger una cuota por minuto alcanza; una ventana deslizante sería más precisa y más cara.
- **El límite es por IP.** Varios clientes detrás de una misma NAT lo comparten, y quien controla muchas IP lo evade. Sin autenticación (fuera de alcance) no hay una clave mejor.
- **Con un solo Redis, la caché y el límite compiten por memoria.** Con `allkeys-lru`, una entrada de caché puede desalojar un contador y regalar alguna pregunta. Con 64 MB y este volumen no pasa en la práctica.
- **Una pieza más que operar**, aunque sin volumen ni backups.

## Alternativas

**Rate limit en memoria del proceso** (por ejemplo, `@nestjs/throttler` con su store por defecto). No necesita Redis, pero el contador se pierde en cada reinicio y no se comparte si el servicio escala a más de una réplica. El plan pedía demostrar Redis, y un límite que se reinicia con el proceso protege mal una cuota diaria. Descartado.

**Rate limit en Caddy.** El rate limit no viene en el build estándar de Caddy (es un plugin aparte), el endpoint quedaría protegido solo en producción, y el servicio no podría responder 503 si no puede contar. Descartado por ahora; se puede sumar en el deploy como una capa extra.

**Invalidar con un simple `DEL`** y aceptar la carrera. Es más simple, pero la carrera deja el timeline viejo hasta 60 s, y el e2e del timeline (que consulta hasta ver los tres eventos) fallaría de vez en cuando. Descartado.

**Escribir el timeline nuevo en la caché desde la proyección** (write-through). Obliga a leer el timeline completo en cada evento, aunque nadie lo pida, y dos proyecciones concurrentes del mismo pedido también pueden pisarse. Descartado.

**Sin caché.** El timeline son dos consultas por índice y Postgres las resuelve rápido; la caché no es necesaria por rendimiento con este volumen. Se mantiene porque es parte del objetivo del plan (Redis con invalidación por eventos) y porque la herramienta del agente puede pedir el mismo timeline varias veces en una pregunta.
