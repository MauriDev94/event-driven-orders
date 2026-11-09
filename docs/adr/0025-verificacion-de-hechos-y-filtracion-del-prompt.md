# ADR-0025 — Verificación de hechos y de filtración del prompt, y `outcome` como contrato de la API

**Estado:** Aceptada · **Fecha:** 2026-11-09 · **Ámbito:** `assistant-service` (`POST /v1/assistant/ask`)

## Contexto

Este ADR documenta lo que ya entregaron el issue #70 (verificar montos y SKU) y el issue #76 (que el asistente no repita su prompt de sistema). Ambos cambiaron el contrato público del asistente y se decidieron en código, sin ADR. [ADR-0022](0022-asistente-con-agente-y-herramientas-de-solo-lectura.md) quedó desactualizado en tres puntos: lista cuatro valores de `outcome`, dice que la verificación "mira IDs, no hechos" y que un monto equivocado pasa.

Los hallazgos que motivaron los cambios:

- **Hechos inventados.** Con solo los UUID verificados, una respuesta como "el pedido costó $99.90" o "faltó stock de SKU-007" salía como `answered` y con citas, aunque ninguna herramienta hubiera devuelto ese dato.
- **Filtración del prompt.** En la pregunta por el stock, el modelo copiaba en inglés una regla del prompt de sistema. Pasó en tres de las seis corridas del set de evaluación del 2026-11-05 ([reporte](../../services/assistant-service/eval/results/2026-11-05-gemini-3.5-flash-lite-status-rule.md)) y era el único caso que seguía fallando. Ninguna verificación lo detectaba.
- **`outcome` lo consume un cliente.** El campo viaja en la respuesta y es la etiqueta de `edo_assistant_questions_total`. Un frontend (paso 7 del roadmap) tiene que manejar cada valor, así que la lista es parte del contrato de la API.

## Decisión

**1. La respuesta se verifica contra todo lo que devolvieron las herramientas** (`domain/grounding.ts`, `domain/facts.ts`, `domain/evidence.ts`). `Evidence` junta, durante una pregunta, los pedidos y eventos, los montos y los SKU de cada salida de herramienta, en cualquier campo (totales, precios unitarios, ids de producto y el SKU dentro de un motivo de rechazo). Si la respuesta nombra un dato que no está ahí, y que tampoco venía en la pregunta, se reemplaza entera por "No tengo datos suficientes para responder eso." con `outcome: ungrounded`. Se revisan tres tipos de dato:

- **IDs (UUID)** de pedido y de evento, sin importar mayúsculas.
- **Montos**, comparados por valor en centavos. Se reconocen un número con uno o dos decimales (`25.50`, `25,5`, `1.250,00`) y un número precedido de `$` (`$20`, `$1.250`, `$ 1,250.00`). Si termina en un separador seguido de una o dos cifras, ese separador es el decimal; los demás separan miles (`$1.250` es mil doscientos cincuenta). Así `$20`, `$20.00`, `20,00` y `20.0` son el mismo monto. Del lado de las herramientas cuentan los números y los strings decimales planos (`"25.50"`).
- **SKU** con prefijo `SKU-`, sin importar mayúsculas.

Un monto que calcula el modelo (una suma de totales) tampoco está en la evidencia y se rechaza; el prompt le pide copiar los montos tal como vienen. El orden en `groundAnswer` es: texto vacío (`no_data`), montos y SKU, y por último los UUID.

**2. La respuesta no puede repetir el prompt de sistema** (`domain/prompt-leak.ts`, usado por `AskAssistant`). Si el texto final comparte 8 palabras seguidas con el prompt, ignorando mayúsculas, puntuación y saltos de línea, se reemplaza por la misma frase fija, sin citas, con `outcome: leaked`. Esta revisión corre antes que la de hechos y solo sobre la respuesta final del modelo. El prompt además pide no citar las reglas, y la del stock ya no es una frase lista para responder. El caso del stock del set de evaluación exige `no_data`, así que el set sigue contando los intentos de filtración aunque el servidor los tape.

**3. `outcome` es parte del contrato de la API.** La respuesta de `POST /v1/assistant/ask` lleva uno de estos cinco valores. Agregar o quitar uno exige un ADR nuevo y avisar a los clientes.

| `outcome` | Cuándo ocurre | Texto | Citas |
|---|---|---|---|
| `answered` | La respuesta se apoya en pedidos que devolvieron las herramientas | El del modelo | Sí |
| `no_data` | El modelo no dijo nada, o su respuesta no se apoya en ningún pedido de las herramientas | La frase fija si venía vacío; si no, el del modelo | Ninguna |
| `ungrounded` | Nombró un ID, un monto o un SKU que ninguna herramienta devolvió ni traía la pregunta | La frase fija | Ninguna |
| `leaked` | Repitió 8 palabras seguidas del prompt de sistema | La frase fija | Ninguna |
| `max_iterations` | El agente agotó los 5 turnos sin responder | La frase fija | Ninguna |

`edo_assistant_questions_total{outcome}` usa estos cinco valores y suma dos que no viajan en la respuesta: `rate_limited` (el guard de rate limit rechaza con 429) y `error` (la pregunta lanzó una excepción, por ejemplo cuota agotada o modelo no disponible, o Redis caído en el guard). Eso corrige el punto 7 de ADR-0022, que hablaba de "los cuatro resultados".

## Consecuencias

**Positivas**

- Un monto o un SKU inventado ya no llega al cliente como `answered`.
- Una filtración del prompt queda contada aparte (`leaked`) y no se mezcla con `ungrounded` en las métricas.
- Todo se decide en `domain/`, con funciones puras que se prueban sin red. El set de evaluación (`npm run eval`, `npm run eval:gemini`) lo mide con el modelo real: 16/16 en tres corridas seguidas después de #76 ([reporte](../../services/assistant-service/eval/results/2026-11-05-gemini-3.5-flash-lite-prompt-leak.md)).

**Negativas / limitaciones aceptadas**

- **Las fechas y los motivos en texto libre no se revisan.** Un parser de fechas y la comparación semántica de un motivo darían más falsos positivos que aciertos. Si el modelo dice una fecha o un motivo equivocado sin nombrar un dato verificable, la respuesta pasa. Las citas permiten revisarla.
- **Los enteros sueltos se saltan a propósito.** Son sobre todo conteos y cantidades ("3 pedidos"), y revisarlos reemplazaría respuestas buenas. Un monto entero sin `$` ("costó 20") tampoco se revisa.
- **Solo se detecta una copia.** Una regla traducida o dicha con otras palabras pasa: no hay forma determinista de detectarla, y el prompt pide no citar las reglas.
- **Falsos positivos posibles.** Una respuesta correcta que calcula un monto, o que repite 8 palabras del prompt por casualidad, se reemplaza. Se acepta: una respuesta a medias verdadera sobre pedidos es peor que ninguna ([ADR-0022](0022-asistente-con-agente-y-herramientas-de-solo-lectura.md)).
- **Los IDs de producto sin el prefijo `SKU-` no son reconocibles** en texto libre, así que no se revisan.
- **El umbral de 8 palabras se eligió a criterio y no está calibrado.** El razonamiento: una respuesta normal comparte frases cortas con el prompt ("don't know", "each order's events"), y ocho palabras seguidas solo deberían aparecer al copiar una regla. La primera medición, offline y del 2026-11-09, lo respalda con lo que hay:
  - Ninguna de las 48 respuestas reales de los reportes de `eval/results/` comparte más de 2 palabras seguidas con el prompt.
  - La regla más corta tiene 13 palabras, así que toda copia completa se detecta.

  Pero esas respuestas están casi todas en español. En inglés, una respuesta legítima a una pregunta fuera de tema, "I can only answer questions about the orders of an online shop", comparte 9 palabras con la primera línea del prompt y se reemplazaría. Por eso `LEAK_WORDS` se trata como un parámetro que se calibra con el set de evaluación, no como parte de la decisión: el valor vigente está en `prompt-leak.ts` y su medición en `eval/results/` ([issue #90](https://github.com/MauriDev94/event-driven-orders/issues/90)). Cambiarlo no exige un ADR nuevo. Una regla nueva más corta que el umbral nunca se detectaría si se copia entera.

## Alternativas

**Revisar también fechas y motivos.** Las fechas llegan en formatos variados ("hoy", "el 1 de noviembre", ISO) y los motivos son texto libre. Un parser y una comparación difusa agregarían falsos positivos y código sin que se haya visto una falla real. Descartado por ahora; queda como limitación.

**Revisar todos los números.** Atraparía más, pero los conteos y las cantidades ("3 pedidos", "cantidad: 2") dispararían falsos positivos todo el tiempo. Descartado a favor de montos y SKU.

**Otro umbral.** Con pocas palabras seguidas, frases normales coinciden con el prompt y se reemplazarían respuestas válidas: en la medición del 2026-11-09, con 6 palabras se marcaban 4 de 7 respuestas legítimas en inglés armadas a mano. Con muchas, una regla corta se copiaría entera sin alcanzarlo, y desde 14 ya no se detectan todas las reglas del prompt actual. El 8 queda en medio, elegido a criterio. Que siga en 8 o pase, por ejemplo, a 10 lo decide la calibración del issue #90.

**Quitar el fragmento filtrado y dejar el resto.** Se podría borrar solo el tramo copiado. Pero una respuesta que copia una regla suele no responder la pregunta, y editar el texto del modelo deja una respuesta que nadie verificó. Se mantiene el criterio de ADR-0022: se reemplaza entera. Descartado.

**Arreglar solo el prompt.** Pedirle al modelo que no cite las reglas reduce el problema pero no lo garantiza: depende del modelo. Se hizo igual, como segunda capa, y la verificación del servidor es la garantía. Descartado como única medida.

**Una nota en ADR-0022.** Un ADR aceptado no se reescribe, y estas dos decisiones cambian el contrato público. Por eso es un ADR nuevo que reemplaza parcialmente al anterior.

## Relación con otros ADR

Reemplaza parcialmente a [ADR-0022](0022-asistente-con-agente-y-herramientas-de-solo-lectura.md): el punto 3 (qué se verifica y la lista de `outcome`), el punto 7 (los labels de la métrica) y la limitación "la verificación mira IDs, no hechos". El resto de ADR-0022 sigue vigente.
