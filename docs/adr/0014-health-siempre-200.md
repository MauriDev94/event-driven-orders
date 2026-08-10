# ADR-0014 — `/health` siempre responde 200, con el estado de dependencias en el body

**Estado:** Aceptada · **Fecha:** 2026-06-07 · **Ámbito:** los 3 servicios

## Contexto

El healthcheck convencional devuelve `503` cuando una dependencia está caída. Docker y Kubernetes marcan entonces el contenedor como no saludable y **lo reinician**.

Pero si el que está caído es PostgreSQL o RabbitMQ, el proceso del servicio está perfectamente vivo. Reiniciarlo **no arregla nada**: vuelve a arrancar, vuelve a no encontrar la dependencia, vuelve a ser reiniciado. Un `CrashLoopBackOff` causado por un problema que está en otra parte.

Además, dos de los tres servicios son workers sin API pública: no tienen un servidor HTTP por el que exponer un probe.

## Decisión

**`/health` siempre responde `200`** y reporta el estado de **cada dependencia** (base de datos, broker) en el body:

```json
{"status": "ok", "db": "healthy", "broker": "unhealthy"}
```

Los workers (`inventory-service`, `notification-service`) **exponen un FastAPI mínimo solo para servir este endpoint**, aunque no tengan API pública.

## Consecuencias

**Positivas**

- Distingue "el proceso está arriba" de "una dependencia está degradada" sin depender del status code.
- Los tres servicios tienen un probe uniforme para Docker/Kubernetes.
- Combinado con [ADR-0013](0013-resiliencia-de-conexion-al-broker.md), un broker caído se refleja en el body y se recupera solo: el orquestador no interviene, porque no hay nada que reiniciar.
- Es el endpoint que se usa para verificar a mano la reconexión al broker.

**Negativas / limitaciones**

- Un orquestador que **solo mira el status code** verá el servicio siempre sano. Para alertar hay que parsear el body.
- Los workers cargan un servidor HTTP que no sirve tráfico de negocio.
