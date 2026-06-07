---
name: "✨ Feature request"
about: Proponer una nueva funcionalidad o mejora
title: "feat: <descripción breve>"
labels: ["enhancement"]
assignees: ""
---

## Problema / necesidad
<!-- ¿Qué problema resuelve? ¿Por qué vale la pena? No describas la solución todavía. -->

## Propuesta
<!-- ¿Cómo lo resolverías? Endpoints, eventos, flujo, comportamiento esperado. -->

## Servicio(s) involucrado(s)
- [ ] `order-service`
- [ ] `inventory-service`
- [ ] `notification-service`
- [ ] `shared/contracts` (nuevo evento de integración)

## Capas involucradas
- [ ] Domain (nuevas entidades / value objects / reglas)
- [ ] Application (nuevos use cases / puertos)
- [ ] Infrastructure (repositorios / providers / messaging)
- [ ] Presentation (routers / consumers / schemas)

## Diseño de API / evento (si aplica)
- **Endpoint:** `<METHOD> /ruta`
- **Evento:** nombre, routing key, payload (campos del contrato Pydantic)
- **Request / Response:**

## Alternativas consideradas
<!-- ¿Qué otras opciones evaluaste y por qué las descartaste? -->

## Criterios de aceptación
- [ ] TDD: tests primero
- [ ] Regla de dependencia respetada (la capa interna no conoce a la externa)
- [ ] DIP: sin imports de SQLAlchemy ni `aio_pika` en `application/` ni `domain/`
- [ ] Contrato del evento en `shared/contracts/` si cruza servicios
- [ ] `ruff check .` + `ruff format --check .` + `mypy app` en verde
- [ ] `pytest -q` en verde, coverage sin bajar del gate
