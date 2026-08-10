# ADR-0018 — La idempotencia no se verifica con un test e2e black-box

**Estado:** Aceptada · **Fecha:** 2026-06-11 · **Ámbito:** `tests/e2e/`

## Contexto

La idempotencia es una de las garantías centrales del sistema ([ADR-0006](0006-idempotencia-con-processed-events.md)): un evento redelivered no debe duplicar efectos de negocio. Es exactamente el tipo de propiedad que uno querría ver verificada de punta a punta.

El problema es **dónde vive la evidencia**. Que un evento se procesó una sola vez se observa en `processed_events` y en `available_quantity` — dos tablas que pertenecen a `order-service` e `inventory-service`. Desde el borde público del sistema no hay forma de distinguir "se procesó una vez" de "se procesó dos veces y la segunda fue un no-op": la orden queda `confirmed` en ambos casos y el email llega igual.

Las dos únicas salidas serían:

1. **Leer las bases de datos directamente desde el test.** Rompe la encapsulación database-per-service ([ADR-0002](0002-database-per-service.md)) que el resto de la suite e2e respeta escrupulosamente — la suite observa solo la API HTTP de `order-service` y la API de Mailhog.
2. **Exponer un endpoint de solo lectura creado ad-hoc para testing.** Agregar superficie pública a un servicio de producción para que un test pueda mirar adentro es peor: convierte un detalle interno en contrato, y ese endpoint queda ahí para siempre.

## Decisión

**La suite e2e no cubre idempotencia.** Se verifica donde tiene sentido probarla: a nivel de **integración contra PostgreSQL real** ([ADR-0008](0008-tests-contra-postgres-real.md)), donde el test es dueño legítimo de la base del servicio bajo prueba y puede asertar directamente sobre `processed_events` y `available_quantity`.

Tests que la cubren:

- `test_order_created_retry_dlq.py` — `inventory-service`
- `test_inventory_results_retry_dlq.py` — `order-service`
- `test_order_events_retry_dlq.py` — `notification-service`

La suite e2e queda con el alcance que le corresponde: camino feliz y camino de rechazo, observados solo por fronteras públicas.

## Consecuencias

**Positivas**

- La suite e2e mantiene una regla sin excepciones: **solo observa fronteras públicas**. Una suite con una excepción "justificada" deja de ser black-box.
- Ningún servicio expone superficie extra por motivos de testing.
- La idempotencia se verifica en el nivel donde el fallo sería visible y el test es preciso, no en el nivel donde apenas se infiere.

**Negativas / limitaciones**

- **No hay verificación de idempotencia atravesando los tres servicios.** Un fallo de idempotencia que solo se manifieste en la interacción entre servicios —y no dentro de uno— no lo atrapa ningún test.
- Cada test de integración prueba el comportamiento de un servicio aislado, asumiendo que el redelivery del broker se comporta como el test lo simula.

## Alternativas

**Cada servicio expone su propio test de idempotencia end-to-end usando su base directamente**, sin pasar por la suite e2e compartida. Es efectivamente lo que se hace: la diferencia es solo dónde vive el archivo. Se prefirió mantenerlos junto al resto de los tests de integración de cada servicio, donde ya está el `conftest` con el `PostgresContainer`.
