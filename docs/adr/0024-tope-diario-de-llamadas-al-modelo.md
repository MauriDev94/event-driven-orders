# ADR-0024 — Tope diario de llamadas al modelo, contado por día del Pacífico

**Estado:** Aceptada · **Fecha:** 2026-11-01 · **Ámbito:** `assistant-service` (`POST /v1/assistant/ask`)

## Contexto

El asistente usa Gemini en el plan gratis ([ADR-0022](0022-asistente-con-agente-y-herramientas-de-solo-lectura.md)). Con `gemini-3.5-flash-lite`, ese plan permite 15 solicitudes por minuto y 500 por día. La [documentación de Google](https://ai.google.dev/gemini-api/docs/rate-limits) dice que los límites se aplican **por proyecto, no por clave**, y que la cuota diaria se reinicia **a la medianoche de la hora del Pacífico**.

El rate limit de [ADR-0023](0023-redis-rate-limit-y-cache-del-timeline.md) cuenta por IP y por minuto: frena a un cliente insistente, pero no a muchos clientes juntos. Una vez publicado el asistente, unas 250 preguntas en un día (cada una hace al menos dos llamadas) agotan la cuota. Después, Gemini responde 429 a todo hasta la medianoche del Pacífico.

ADR-0022 dejó este tope pendiente para el deploy.

## Decisión

**1. Un presupuesto diario de llamadas al modelo, global y en Redis.**

- Es un puerto de la aplicación, `ModelCallBudget.take()`. `AskAssistant` toma una llamada del presupuesto antes de cada turno del modelo, no una por pregunta: una pregunta hace de 2 a 5 llamadas, y lo que Google cuenta son las llamadas.
- Si el presupuesto se agotó, la pregunta termina con `LlmQuotaExceededError`, el mismo error de un 429 de Gemini, y el endpoint responde 503 ("the assistant ran out of model quota"). Si se agota en medio de una pregunta, esa pregunta también termina así: no se hace la llamada siguiente.
- El límite es de 400 llamadas por día (`LLM_DAILY_CALL_LIMIT`), por debajo de las 500 de Google. El margen cubre los reintentos ante fallas momentáneas, que el presupuesto no cuenta (punto 3), y las pruebas a mano con la misma clave.

**2. El día es el de la hora del Pacífico.** `RedisModelCallBudget` usa una clave por día, `model-calls:YYYY-MM-DD`, con la fecha en `America/Los_Angeles`. Así el presupuesto se reinicia junto con la cuota de Google. `INCR` y `EXPIRE … NX` (2 días) van en un mismo `MULTI`, como el rate limit.

**3. Un reintento ante fallas momentáneas de Gemini.** En la prueba en vivo, Gemini respondió 503 a una pregunta, y la misma pregunta funcionó segundos después. `GeminiLlmClient` reintenta una vez, después de 1 s, cuando la API responde 500 o 503. La espera respeta el tiempo de la pregunta (30 s): si se acaba, el reintento no ocurre. Un 429 no se reintenta: con la cuota agotada, reintentar solo la gasta más rápido. Como el reintento vive en el adaptador, el presupuesto lo cuenta como una sola llamada.

**4. Falla cerrado.** Si Redis no responde, el presupuesto no se puede consultar y la pregunta recibe 503, igual que con el rate limit: los dos existen para proteger la cuota.

## Consecuencias

**Positivas**

- La cuota diaria del plan gratis queda protegida aunque el asistente sea público: el tope corta antes que Google.
- El tope y el reintento se prueban sin red: el use case con un presupuesto de prueba, el adaptador contra Redis real (incluido el cambio de día a la medianoche del Pacífico) y el reintento con un `generateContent` falso.
- Con el stack de producción en local, una pregunta del modelo `fake` dejó `model-calls:<fecha del Pacífico>` en 2, con su expiración.

**Negativas / limitaciones**

- **El tope es global:** quien pregunte mucho puede agotarlo para los demás, aunque el rate limit por IP lo hace más lento. Sin autenticación no hay un reparto más justo.
- **Las llamadas del modelo `fake` también se cuentan.** No gastan cuota de Google, pero consumen el presupuesto del día; en desarrollo, 400 alcanzan de sobra.
- **El tope no ve otros usos de la misma clave.** Si la clave se usa también fuera del servicio, Google puede cortar antes que el tope. Por eso hay margen bajo las 500.
- **Una pregunta que se queda sin presupuesto a la mitad** ya gastó sus primeras llamadas sin dar respuesta. Es el costo de contar llamadas y no preguntas.

## Alternativas

**Contar preguntas en vez de llamadas.** Es más simple, pero una pregunta puede hacer hasta 5 llamadas, así que el límite tendría que ser de 100 preguntas para el peor caso, cuando lo normal son 2 llamadas por pregunta. Descartado.

**El día UTC o el de Chile.** No coinciden con la cuota de Google: un día de Google atraviesa dos días UTC, así que en el peor caso pasarían dos topes enteros dentro de un mismo día de Google. Descartado.

**Responder 429 al agotar el tope.** El 429 es para un cliente que se pasó de su límite, y acá no es culpa de quien pregunta: el servicio se quedó sin capacidad por hoy. Un 503 con el mismo mensaje que la cuota de Gemini es más honesto. Descartado.

**Dejar que Gemini corte con su 429.** Funciona sin código, pero no deja margen: cualquier prueba a mano el mismo día o un reintento rompe el asistente hasta la medianoche del Pacífico, y el corte no se ve en nuestras métricas. Descartado.
