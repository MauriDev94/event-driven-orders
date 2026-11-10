# ADR-0026 — Un Redis compartido con `volatile-ttl`: toda clave con TTL y topes que no dependen del cliente

**Estado:** Aceptada · **Fecha:** 2026-11-10 · **Ámbito:** `assistant-service`, `docker-compose*.yml` · **Modifica parcialmente:** [ADR-0023](0023-redis-rate-limit-y-cache-del-timeline.md) y [ADR-0024](0024-tope-diario-de-llamadas-al-modelo.md)

## Contexto

Un solo Redis de 64 MB guarda el rate limit de `/ask`, el contador diario de llamadas al modelo ([ADR-0024](0024-tope-diario-de-llamadas-al-modelo.md)) y la caché del timeline ([ADR-0023](0023-redis-rate-limit-y-cache-del-timeline.md)). La auditoría del 2026-11-07 encontró premisas de ADR-0023 que no se sostienen:

- **SEC-02: el tamaño de la caché lo controla el visitante.** Con `allkeys-lru`, llenar la caché con timelines grandes puede desalojar el contador diario, que entonces vuelve a 1 y deja de proteger la cuota. ADR-0023 aceptó compartir la memoria con "no pasa en la práctica"; con un visitante que elige el tamaño de las entradas, sí puede pasar.
- **OPS-01: el límite por IP no cubre la cuota por minuto.** ADR-0023 dijo que el límite por IP protegía la cuota por minuto de Gemini. Pero 5 preguntas por minuto de una IP pueden ser 25 llamadas al modelo (hasta 5 por pregunta), y el plan gratis permite 15 por minuto. Una sola IP ya la pasa.
- **SEC-04: el timeline no tenía límite.** `GET /v1/assistant/orders/{id}/timeline` se podía llamar sin tope, y cada lectura puede llenar la caché.

El 2026-11-08 se decidió mantener un solo Redis.

## Decisión

**1. Política `volatile-ttl`.** Redis corre con `--maxmemory 64mb --maxmemory-policy volatile-ttl` (`docker-compose.yml`). Ante presión de memoria expulsa primero la clave con menos tiempo de vida restante.

**2. Toda clave tiene TTL, puesto en el mismo comando atómico que la crea.** Con esta política, una clave sin TTL no se expulsa nunca. `test/integration/core/redis-keys-have-ttl.spec.ts` ejercita cada camino de escritura contra Redis real y comprueba que ninguna clave quede sin TTL. Los TTL ordenan la expulsión, de primero a último:

| Clave | TTL |
|---|---|
| `rate-limit:ask:<ip>`, `rate-limit:timeline:<ip>` | 60 s |
| `order-timeline:<id>` (entrada de caché) | 60 s |
| `model-calls:minute:<minuto>` | 120 s |
| `order-timeline:<id>:generation` | 600 s |
| `model-calls:<fecha del Pacífico>` | 2 días |

El contador diario es lo último que se expulsa.

**3. Una entrada de caché de más de 64 KB no se guarda.** `RedisTimelineCache` mide el JSON serializado en bytes UTF-8 (`maxEntryBytes`, 64 × 1024); si lo pasa, devuelve el timeline leído de Postgres sin cachearlo.

**4. Rate limit propio en el timeline.** `GET /v1/assistant/orders/{id}/timeline` limita a 120 lecturas por minuto por IP (`TIMELINE_RATE_LIMIT_PER_MINUTE`), con la clave `rate-limit:timeline:<ip>`. Pasado el límite responde 429 con `Retry-After`. **Falla abierto**: si Redis no puede contar, la lectura pasa, porque el endpoint solo lee Postgres. `/ask` sigue fallando cerrado ([ADR-0023](0023-redis-rate-limit-y-cache-del-timeline.md)). El limitador se movió a `src/core/rate-limit/` para que `order-history` lo reutilice sin importar la feature `assistant`.

**5. Tope global de 15 llamadas al modelo por minuto.** `LLM_MINUTE_CALL_LIMIT` (15 por defecto, el límite del plan gratis para el modelo por defecto) usa una ventana fija por minuto calendario, en la clave `model-calls:minute:<minuto desde la época>`. `RedisModelCallBudget.take()` ejecuta un script Lua que revisa **primero** los dos contadores (minuto y día) y solo después incrementa los dos. Una llamada rechazada por uno no gasta una unidad del otro. El script pone el TTL de cada clave en el mismo comando (`EXPIRE … NX`). Rechazada por cualquiera de los dos topes, la pregunta termina con `LlmQuotaExceededError` (503), igual que en ADR-0024.

**6. Los cuatro límites se configuran igual:** `ASK_RATE_LIMIT_PER_MINUTE` (5), `LLM_DAILY_CALL_LIMIT` (400), `LLM_MINUTE_CALL_LIMIT` (15) y `TIMELINE_RATE_LIMIT_PER_MINUTE` (120), por `env.ts`, `docker-compose.yml`, `.env.example` y `deploy/env.production.example`.

## Consecuencias

**Positivas**

- Llenar la caché ya no puede desalojar el contador diario: se expulsa primero lo que vence antes, y el diario vence último.
- Ninguna IP sola puede pasar de forma sostenida la cuota por minuto de Gemini. El borde entre dos minutos es la excepción (abajo).
- La regla "toda clave con TTL" tiene un test que la hace cumplir.

**Negativas / limitaciones**

- **En el borde entre dos minutos pasa hasta el doble del tope en pocos segundos.** Gemini cuenta en una ventana móvil, responde 429 y esa pregunta recibe un 503. El 2026-11-10 se decidió mantener 15 y documentarlo, en vez de construir una ventana deslizante.
- **El reintento de `GeminiLlmClient` ante un 500 o 503 no pasa por el presupuesto** ([ADR-0024](0024-tope-diario-de-llamadas-al-modelo.md)), así que las llamadas reales pueden pasar un poco el tope.
- **El tope por minuto es global:** unas pocas IP pueden agotarlo para todos. Es inherente a un tope global; con autenticación (issues #92 a #96) los límites seguirán siendo por IP.
- **Bajo presión de memoria, un contador de generación puede expulsarse mientras su entrada sobrevive.** Queda una carrera estrecha en la que se sirve un timeline viejo hasta 60 s. Por eso lo que dice ADR-0023, que el contador vive más que toda entrada, ya no vale de forma absoluta.
- **Muchas IP pueden llenar Redis con claves de rate limit de 60 s**, que se expulsan primero, y así reiniciar el límite de otros clientes. No tocan el contador diario. Según la estimación de la revisión, llenar 64 MB toma unas 9 IP con entradas de 64 KB y 120 lecturas por minuto cada una.
- **Una clave futura sin TTL no se expulsaría nunca** y, si se llena la memoria, haría fallar las escrituras, con lo que `/ask` respondería 503 (falla cerrado). El test de integración es la defensa.

## Alternativas

**Un segundo Redis** para el contador y los límites, aparte de la caché. Aísla del todo, pero suma una pieza más que operar y configurar. Descartado por costo operativo (decisión del 2026-11-08).

**`volatile-lru`.** Toda clave tiene TTL, así que todas son candidatas y el contador diario no queda protegido. Descartado.

**Dos `INCR` en un `MULTI`.** Una llamada rechazada por el tope por minuto igual gastaría una unidad diaria por una llamada al modelo que no ocurrió. Descartado a favor del script.

**Ventana deslizante para el tope por minuto.** Coincide mejor con la ventana de Google, pero pide más script y más tests; se eligió ventana fija más la limitación documentada. Descartado.

**Un tope menor por defecto, como 10.** Pierde un tercio del rendimiento y tampoco garantiza nada en el borde de la ventana. Descartado.
