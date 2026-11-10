# ADR-0027 — Identidad anónima firmada: cada visitante ve solo sus pedidos

**Estado:** Aceptada · **Fecha:** 2026-11-10 · **Ámbito:** `order-service`, `assistant-service`, `docker-compose*.yml`, `scripts/generate_env.py`, CI · **Modifica parcialmente:** [ADR-0022](0022-asistente-con-agente-y-herramientas-de-solo-lectura.md)

## Contexto

Hoy no hay identidad. Lo único que protege un pedido es que su UUID no se puede adivinar, y `customer_id` es un texto que el cliente escribe en el body de `POST /v1/orders`. El asistente rompe esa protección (roadmap, Paso 4; auditoría del 2026-11-07, SEC-03):

- `search_orders` y `rejection_summary` recorren todos los pedidos, sin filtro por cliente.
- Las citas y el texto de la respuesta nombran pedidos de cualquiera. Preguntando por franjas de tiempo se pueden enumerar todos, y cada UUID obtenido sirve para leer el pedido con `GET /v1/orders/{id}` o con `/timeline`.

**Reducir las citas no alcanza.** Las citas se arman en el servidor ([ADR-0022](0022-asistente-con-agente-y-herramientas-de-solo-lectura.md)), pero el modelo recibe los IDs que devuelve `search_orders` y puede escribirlos en su texto. [ADR-0025](0025-verificacion-de-hechos-y-filtracion-del-prompt.md) acepta un UUID en la respuesta justamente cuando una herramienta lo devolvió. Mientras la herramienta pueda devolver pedidos ajenos, hay que filtrar en la consulta, no en la respuesta.

El 2026-11-09 el usuario aprobó la opción B del diseño del software-architect: una sesión anónima firmada. Este ADR registra esa decisión; la implementación va en los issues #93 a #96.

## Decisión

**1. `order-service` emite el token.** `POST /v1/session` devuelve `{ "access_token", "token_type": "bearer", "expires_in" }`. El token es un JWT HS256 firmado con un secreto compartido, `AUTH_TOKEN_SECRET`, de al menos 32 bytes y generado por `make env`. Los claims son:

| Claim | Valor |
|---|---|
| `iss`, `aud` | fijos, los mismos en el emisor y en los verificadores |
| `sub` | un `customer_id` aleatorio. Cumple `ID_PATTERN` (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) y tiene como máximo 36 caracteres (`ID_MAX_LENGTH`), igual que hoy |
| `iat`, `exp` | `exp` a los 7 días |
| `typ` | `"session"` |

No hay tabla de clientes ni de sesiones. **Sin refresh, sin renovación y sin revocación:** un token vale 7 días y nada más. Cambiar el secreto cierra todas las sesiones.

**2. Cada servicio verifica por su cuenta.** `order-service` con PyJWT y `assistant-service` con `jose`, los dos con `algorithms=["HS256"]` fijo (así `alg: none` no pasa), `iss`, `aud`, `exp` y 30 s de tolerancia de reloj. No hay HTTP entre servicios, así que [ADR-0001](0001-comunicacion-asincrona-por-eventos.md) queda intacto. Ninguno de los dos servicios arranca sin un secreto de al menos 32 bytes.

**3. Transporte: `Authorization: Bearer`, por ahora.** Funciona con curl, con el botón "Authorize" de Swagger (`HTTPBearer`) y en los e2e, y no tiene CSRF. La cookie `HttpOnly` y sus reglas de CSRF llegan con el SPA del Paso 7, en un ADR aparte o en una sección de este.

**4. Reglas de `order-service`.**

- `customer_id` sale del token, no del body. `CreateOrderRequest` pasa a `extra="forbid"`: mandarlo da 422.
- `GET /v1/orders/{id}` de un pedido ajeno responde **404, no 403**, con el mismo body que un pedido que no existe, para no confirmar que existe. `GetOrderUseCase` recibe el cliente y lanza `NotFoundError`.
- Sin token, o con uno inválido, responde 401 con `WWW-Authenticate: Bearer`.

**5. Reglas de `assistant-service`.**

- **El servidor fija a qué pedidos acceden las herramientas.** `customerId` pasa a ser obligatorio en `OrderViewScope` (`order-history`) y en el puerto `OrderQueries`, así que no puede existir una consulta sin ese filtro. `AskAssistant` recibe una fábrica de herramientas y arma `buildOrderTools(queries, customerId)` en cada pregunta. El modelo nunca elige el cliente, y zod descarta cualquier `customer_id` que invente.
- **`/timeline` revisa quién es el dueño.** `GetOrderTimeline.execute(orderId, customerId)` devuelve 404 para un pedido ajeno, en el endpoint y en la herramienta. La caché ([ADR-0023](0023-redis-rate-limit-y-cache-del-timeline.md)) sigue siendo por pedido; el dueño se revisa después de leerla.
- Un guard verifica el token en `/v1/assistant/ask` y en `/timeline`. En `/ask` corre antes de `AskRateLimitGuard`. Sin token, o con uno inválido, responde 401.
- Un índice nuevo en `order_view(customer_id, last_event_at)`, una regla en el prompt (solo ves los pedidos de quien pregunta, sin redactarla como una frase lista para responder, lo aprendido en #76) y `redact` de `req.headers.authorization` y `req.headers.cookie` en pino-http (SEC-06).

**6. Los límites no cambian.** Crear una identidad no cuesta nada, así que un límite por identidad no frena a nadie. Siguen los límites por IP de `/ask` y `/timeline` ([ADR-0023](0023-redis-rate-limit-y-cache-del-timeline.md), [ADR-0026](0026-redis-compartido-ttl-y-topes.md)), y los topes de llamadas al modelo, por minuto y por día, siguen siendo globales ([ADR-0024](0024-tope-diario-de-llamadas-al-modelo.md), [ADR-0026](0026-redis-compartido-ttl-y-topes.md)).

**7. Verificación cruzada en CI.** Un job chico genera un secreto en el momento, emite un token con PyJWT (con la misma configuración que `order-service`) y lo verifica con `jose` (con la misma configuración que el guard). Nada comprueba hoy que dos librerías distintas se entiendan; este job sí.

### Implementación

| Issue | Servicio | Qué cambia |
|---|---|---|
| [#93](https://github.com/MauriDev94/event-driven-orders/issues/93) | `order-service` e infra | **Nuevo:** feature `app/features/session/` (`POST /v1/session`, puerto `TokenIssuer` en `application/contracts`, adaptador PyJWT en `infrastructure`) y la dependencia `get_current_customer`. **Cambia:** `app/features/orders/presentation/http/router.py`, `.../http/schemas/order_schemas.py` (`CreateOrderRequest`), `.../http/mappers/order_mapper.py`, `app/features/orders/application/usecases/get_order_use_case.py`, `app/core/config/env_config.py` (`auth_token_secret`), `services/order-service/pyproject.toml` (PyJWT), `.env.example`, `deploy/env.production.example`, `docker-compose.yml` y `docker-compose.prod.yml` (guarda `${AUTH_TOKEN_SECRET:?}` pelada, para `order-service` y `assistant-service`), `scripts/generate_env.py` (claves `*_SECRET` de 32 bytes o más) y `tests/e2e/test_order_flow.py`. README y CLAUDE.md |
| [#94](https://github.com/MauriDev94/event-driven-orders/issues/94) | `assistant-service` y CI | **Nuevo:** guard con `jose` en `src/core/auth/`, la migración del índice en `prisma/migrations/` y el job de CI de la verificación cruzada. **Cambia:** `src/features/order-history/application/contracts/order-view.queries.ts` (`OrderViewScope`), `.../order-history/application/usecases/get-order-timeline.ts`, `.../order-history/infrastructure/prisma-order-view.queries.ts`, `.../order-history/presentation/http/order-timeline.controller.ts`, `src/features/assistant/application/contracts/order-queries.ts`, `.../assistant/application/tools/order-tools.ts`, `.../assistant/application/usecases/ask-assistant.ts`, `.../assistant/infrastructure/read-model-order-queries.ts`, `.../assistant/presentation/http/assistant.controller.ts`, `prisma/schema.prisma`, `src/core/config/env.ts`, `src/core/observability/logging.ts` (`redact`), `eval/in-memory-order-queries.ts`, `.github/workflows/ci.yml`, `tests/e2e/test_assistant_timeline.py` y CLAUDE.md |
| [#95](https://github.com/MauriDev94/event-driven-orders/issues/95) | `assistant-service` | `eval/cases.ts`: dos o tres casos adversariales (el ID de un pedido ajeno, "los pedidos de todos los clientes", "ignora el filtro de cliente"), que esperan `no_data` y que no citen pedidos ajenos. Puntaje nuevo con `fake` en el README y en CLAUDE.md |
| [#96](https://github.com/MauriDev94/event-driven-orders/issues/96) | `order-service` y `assistant-service` | **Nuevo:** el e2e de dos visitantes en `tests/e2e/`. **Cambia:** README (ejemplos con `TOKEN=$(curl ... /v1/session \| jq -r .access_token)`, "Authorize", sección del asistente, tabla de ADRs), CLAUDE.md, `docs/deploy.md` (`AUTH_TOKEN_SECRET` en `.env.production`) y `docs/roadmap.md` |

Los tests generan sus secretos y sus tokens en el momento. Ni el repo ni este ADR llevan un JWT de ejemplo, porque GitGuardian lo marca.

## Consecuencias

**Positivas**

- Un visitante solo alcanza sus pedidos, por el endpoint, por el timeline y por las herramientas del asistente. El filtro está en la consulta, así que ni el prompt ni el modelo pueden saltárselo.
- Sin fricción ni datos personales para el visitante: no hay cuenta, ni email, ni pantalla de consentimiento.
- Sin estado nuevo: no hay tabla de clientes ni de sesiones, y `notification-service` y los contratos de eventos no cambian.
- Cada servicio verifica solo, sin HTTP entre ellos: ADR-0001 sigue valiendo y la verificación no suma una dependencia de disponibilidad.
- #80 (tope al contexto) pasa a afectar solo al visitante que lo provoca, porque ya no puede inflar el contexto con pedidos de otros. Sigue haciendo falta: la cuota de Gemini es compartida.

**Negativas / limitaciones aceptadas**

- **La identidad es tener el token.** Quien lo copia es ese visitante. Perder el token (limpiar el navegador, otro dispositivo) deja sus pedidos sin dueño alcanzable, y no hay recuperación. `GET /v1/orders` ("mis pedidos") no entra en este trabajo: llega con el SPA.
- **Crear identidades es gratis,** así que los límites por IP son el freno real, y valen lo que vale una IP: varias IP o una red compartida los esquivan o los comparten ([ADR-0023](0023-redis-rate-limit-y-cache-del-timeline.md), [ADR-0026](0026-redis-compartido-ttl-y-topes.md)). El tope de llamadas al modelo sigue siendo global: unas pocas IP pueden agotarlo para todos.
- **Sin revocación.** Un token robado vale hasta 7 días. La única salida es rotar `AUTH_TOKEN_SECRET`, que cierra **todas** las sesiones y obliga a reiniciar `order-service` y `assistant-service` con el valor nuevo.
- **Secreto simétrico compartido:** `assistant-service` también podría emitir tokens. Es el mismo dominio de confianza (un solo repo, un solo compose) y se acepta. Un verificador fuera del compose, o un proveedor de identidad externo, pediría un algoritmo asimétrico o JWKS.
- **Bearer en el cliente.** Hasta que llegue la cookie con el SPA (Paso 7), el cliente guarda el token él mismo, y un XSS en el SPA podría leerlo. Este ADR no define la cookie ni su CSRF.
- **Un timeline sin `order.created` responde 404.** Si el evento no llegó, el read model no tiene `customer_id` y no se puede decidir de quién es. Responde 404 hasta que llegue, aunque el pedido exista en `order-service`.
- **Los pedidos anteriores quedan inalcanzables.** Su `customer_id` fue texto libre y ningún `sub` aleatorio coincide con él. Son datos de demo; no se migran.
- **`/ask` y `/timeline` rechazan sin token antes del rate limit.** El guard corre primero, así que un 401 no gasta el límite por IP. Verificar una firma es barato, y se acepta.
- **La dirección de [ADR-0010](0010-email-derivado-del-customer-id.md) no cambia:** sigue siendo `<customer_id>@example.com`, ahora con el `sub` aleatorio, que cumple el mismo `ID_PATTERN`. Los e2e que buscan el email por destinatario deben usar el `sub` de su sesión. El ADR-0010 sigue valiendo entero.

## Alternativas

**Google SSO, como Monolith.** Da identidad real y cuotas por persona. Pero pide cuenta de Google, una pantalla de consentimiento, datos personales, una tabla de usuarios y refresh con rotación; el client secret de Google no lo genera `make env`, la redirect URI exige un dominio y los e2e necesitan un stub. Y repetiría lo que Monolith ya muestra. Descartada por fricción, datos personales y costo.

**Un código por email (login sin contraseña).** Identidad real sin Google, pero es la de mayor fricción y operación: SMTP real en producción (hoy el correo va a Mailpit), datos personales, una tabla de clientes y un evento nuevo en `notification-service` para mandar el código. Descartada.

**`forward_auth` de Caddy.** Caddy solo existe en producción; en local no hay quien valide. Los servicios tendrían que confiar en un header que, en local, cualquiera puede mandar. Descartada.

**Un proveedor hosteado (Auth0, Clerk).** Una cuenta externa y la misma fricción que Google SSO. Descartada.

**Un token por pedido.** No resuelve las preguntas agregadas del asistente ("¿qué pedidos míos se rechazaron hoy?"), que necesitan una identidad que agrupe pedidos. Descartada.
