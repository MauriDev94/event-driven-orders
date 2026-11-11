# ADR-0028 — La caché del timeline guarda una entrada por pedido y por cliente

**Estado:** Aceptada · **Fecha:** 2026-11-11 · **Ámbito:** `assistant-service` · **Modifica parcialmente:** [ADR-0023](0023-redis-rate-limit-y-cache-del-timeline.md) y [ADR-0027](0027-identidad-anonima-firmada.md)

## Contexto

[ADR-0027](0027-identidad-anonima-firmada.md) dejó la caché del timeline por pedido, con la revisión del dueño después de leerla. La revisión de seguridad del #94 (SEC94-01) midió lo que eso expone. La respuesta a un pedido ajeno es idéntica a la de un pedido inexistente (mismo status, body, headers y ETag), pero el camino que recorre no:

- **Pedido inexistente:** una consulta a Postgres, sin fila.
- **Pedido ajeno con la caché fría:** dos consultas y un `SET` en Redis, porque el visitante cargaba el pedido y lo guardaba.
- **Pedido ajeno con la caché caliente:** ninguna consulta.

Medido en local, p10 a p90: inexistente, de 2,56 a 3,54 ms; ajeno en frío, de 3,99 a 5,44 ms; ajeno en caliente, de 1,80 a 2,43 ms. Quien ya tiene el UUID de un pedido ajeno sabe si existe pidiéndolo dos veces. Repitiendo la consulta, también ve cuándo tuvo actividad, porque cada evento enfría la caché. Nunca ve el contenido.

`order-service` cerró el mismo problema en el #93 filtrando por cliente en la consulta. ADR-0027 aplica ese principio a las herramientas del asistente, pero no a la caché.

## Decisión

**La entrada se guarda por pedido y por cliente, y la carga filtra por cliente en la consulta.**

- La clave de la entrada es `order-timeline:<orderId>:customer:<customerId>`, con TTL de 60 s.
- El contador de generación sigue siendo uno por pedido: `order-timeline:<orderId>:generation`, con TTL de 600 s ([ADR-0026](0026-redis-compartido-ttl-y-topes.md)).
- `GetOrderTimeline.execute(orderId, customerId)` lee su propia entrada. Si no la encuentra, carga con `PrismaOrderHistoryRepository.findTimeline(orderId, customerId)`, que lee `order_view` con `WHERE order_id AND customer_id` y, solo si hay fila, los eventos.

Con eso, un pedido ajeno, uno inexistente y uno cuyo `order.created` todavía no llega cuestan lo mismo: una consulta filtrada, sin fila y sin escribir en la caché. Un visitante nunca lee ni escribe la entrada de otro.

**La invalidación ya no hace `DEL`.** `ProjectOrderEvent` sigue llamando a `invalidate(orderId)` después del commit, pero la proyección no sabe para qué cliente se guardó cada entrada. Por eso `invalidate` solo hace `INCR` y `EXPIRE` del contador. Una entrada guarda la generación que vio antes de cargar ([ADR-0023](0023-redis-rate-limit-y-cache-del-timeline.md)), así que todas las entradas del pedido pasan a contar como fallo de caché y vencen solas con su TTL. El protocolo que evita la carrera de ADR-0023 no cambia.

**Las claves no chocan.** `ID_PATTERN` no admite `:`, y toda clave de entrada lleva `:customer:` al medio. Ni un cliente llamado `generation` puede producir la clave de un contador. Además, un `orderId` que no cumple el patrón (un NUL, 12 000 caracteres, un `:`) cuenta como inexistente antes de llegar a Redis o a Postgres.

## Consecuencias

**Positivas**

- Se cierra el oráculo de tiempo, sin dejar de usar la caché: el dueño sigue leyendo desde Redis.
- Es la misma regla que en `order-service` y en las herramientas del asistente: el filtro por cliente va en la consulta, no después.
- Un visitante ya no llena Redis con timelines de pedidos ajenos.

**Negativas / limitaciones aceptadas**

- Después de una invalidación, la entrada vieja ocupa memoria hasta 60 s, porque ya no se borra. En la práctica cada pedido tiene una sola entrada, la de su dueño, y el tope de 64 KB por entrada se mantiene.
- Queda una diferencia que no se puede quitar: el dueño con la caché caliente responde más rápido que cualquier 404. Eso solo le dice al dueño algo sobre su propio pedido.
- `/timeline` sigue revelando, como cualquier 404, que un UUID no es tuyo o no existe, sin distinguir entre las dos cosas.

## Alternativas

**Aceptar el oráculo y documentarlo.** No cambiaba código. Pero dejaba ver la existencia y la actividad de un pedido ajeno a quien ya tuviera su UUID, contra la regla de ADR-0027 de que un pedido ajeno no se confirma. Descartada el 2026-11-11.

**Revisar el dueño con una consulta antes de leer la caché.** Iguala los tiempos, pero le suma una consulta a Postgres a cada lectura, también a las del dueño, y le quita a la caché casi todo su sentido ([ADR-0023](0023-redis-rate-limit-y-cache-del-timeline.md)). Descartada.
