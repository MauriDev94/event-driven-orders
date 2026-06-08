---
name: "🐛 Bug report"
about: Reportar un comportamiento incorrecto en algún servicio o en el flujo de eventos
title: "bug: <descripción breve>"
labels: ["bug"]
assignees: ""
---

## Descripción
<!-- ¿Qué está fallando? Sé concreto. -->

## Servicio(s) afectado(s)
- [ ] `order-service`
- [ ] `inventory-service`
- [ ] `notification-service`
- [ ] `shared/contracts`
- [ ] Infra (RabbitMQ / Postgres / Mailhog / docker-compose)

## Pasos para reproducir
1.
2.
3.

## Comportamiento esperado
<!-- ¿Qué debería pasar? -->

## Comportamiento actual
<!-- ¿Qué pasa en realidad? Incluí status code / body o el evento publicado si aplica. -->

## Capa afectada
- [ ] Domain (entidades / value objects / reglas de negocio)
- [ ] Application (use cases / contratos / puertos)
- [ ] Infrastructure (repositorios / providers / messaging)
- [ ] Presentation (routers HTTP / consumers de eventos / schemas)
- [ ] Core / Config (middleware / exceptions / DB / broker)

## Contexto técnico
- **Endpoint o evento:** `<METHOD> /ruta` o `OrderCreated` / `StockReserved` / ...
- **Correlation ID:** <!-- para rastrear el evento entre servicios -->
- **Entorno:** local / CI

## Logs relevantes
```
<!-- pegá acá las líneas de log con el correlation id -->
```

## Criterios de aceptación
- [ ] Test que reproduce el bug (falla antes del fix — TDD)
- [ ] Fix aplicado en la capa correcta
- [ ] `ruff check .` + `ruff format --check .` + `mypy app` en verde
- [ ] `pytest -q` en verde
