---
name: "📋 Tarea"
about: Paso de desarrollo, refactor o trabajo técnico
title: "task: <descripción breve>"
labels: ["task"]
assignees: ""
---

## Descripción
<!-- ¿Qué hay que hacer? Contexto técnico: servicio, capas, eventos, contratos, etc. -->

## Servicio(s) afectado(s)
- [ ] `order-service`
- [ ] `inventory-service`
- [ ] `notification-service`
- [ ] `shared/contracts`
- [ ] Infra / CI

## Alcance
<!-- Qué entra y qué NO entra en esta tarea. -->

## Criterios de aceptación
- [ ] TDD: tests primero
- [ ] Cambio aislado en la(s) capa(s) correcta(s)
- [ ] `ruff check .` + `ruff format --check .` + `mypy app` en verde
- [ ] `pytest -q` en verde
- [ ] Commit con conventional commits (en español)
