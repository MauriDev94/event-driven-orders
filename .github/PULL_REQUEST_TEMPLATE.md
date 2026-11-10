## 📌 Issue relacionado

Closes #<!-- número del issue -->

## 🧠 Resumen

_Qué hace este PR, en 2-3 líneas._

## 🧩 Servicio(s) afectado(s)

- [ ] `order-service`
- [ ] `inventory-service`
- [ ] `notification-service`
- [ ] `assistant-service`
- [ ] `shared/contracts` (integration events)
- [ ] Infra / CI (docker-compose, `.github/`, Makefile)

## 📂 Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `path/to/file` | _Qué cambió y por qué_ |

## ✅ Checklist

- [ ] Lint + format pasan: `ruff check . && ruff format --check .`
- [ ] Type checking pasa: `mypy app`
- [ ] Tests pasan: `pytest -q` → N passed, 0 failed
- [ ] Coverage no baja del gate del servicio (`fail_under` en `pyproject.toml`)
- [ ] `assistant-service` (en vez de los 4 anteriores): `npm run lint && npm run typecheck && npm run format:check` y `npm run test:cov`
- [ ] Sin lógica de negocio en routers/consumers (presentación delgada)
- [ ] DIP: sin imports de SQLAlchemy ni `aio_pika` en `application/` ni `domain/`
- [ ] Los use cases hablan con el puerto `EventPublisher`, no con el broker directo
- [ ] Contratos entre servicios viven en `shared/contracts/`
- [ ] Conventional commits (en español)

## 🧪 Cómo probar

```bash
cd services/<servicio>
ruff check . && ruff format --check . && mypy app
pytest -q
```

## 📝 Notas técnicas

<!-- Opcional — gotchas, decisiones de diseño no obvias, eventos nuevos, DLQ/retries -->
