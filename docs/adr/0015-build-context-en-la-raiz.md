# ADR-0015 — Build context en la raíz del repo y dependencias por servicio

**Estado:** Aceptada · **Fecha:** 2026-06-07 · **Ámbito:** monorepo

## Contexto

Los tres servicios necesitan `shared/` dentro de su imagen ([ADR-0003](0003-shared-contratos-e-infraestructura-transversal.md)). Docker **no puede copiar archivos que estén fuera del build context**, así que un context apuntando a `services/<servicio>/` deja `shared/` inalcanzable.

Las salidas habituales son publicar `shared/` como paquete en un índice privado, o usar git submodules. Ambas agregan un paso de publicación y versionado a cada cambio de contrato — desproporcionado para un monorepo de tres servicios.

## Decisión

**El build context de cada servicio es la raíz del repo.** Cada `Dockerfile` se referencia explícitamente con `build.dockerfile` en `docker-compose.yml`.

**Las dependencias son por servicio, no globales:**

| Archivo | Contenido |
|---|---|
| `requirements.txt` | Dependencias de runtime |
| `requirements-dev.txt` | pytest, ruff, mypy |
| `pyproject.toml` | Configuración de ruff/mypy/pytest y el **coverage gate** (`[tool.coverage.report] fail_under`) |

Mismo patrón que el proyecto [Monolith](https://github.com/MauriDev94/Api_monolith) de referencia.

## Consecuencias

**Positivas**

- `shared/` entra en cada imagen sin submodules ni paquete publicado.
- Cada servicio declara y versiona sus dependencias y su gate de cobertura de forma independiente: `order-service` y `notification-service` están en 85, `inventory-service` en 40.
- CI puede cachear `pip` por servicio.

**Negativas / limitaciones**

- El build context es **todo el repo**. Al no existir un `.dockerignore` en la raíz, el daemon recibe también `.venv/`, los caches (`.mypy_cache/`, `.ruff_cache/`) y `.git/` en cada build.
- `make install` crea un `.venv` **compartido** para desarrollo local, que no refleja el aislamiento real de las imágenes: una dependencia que falta en el `requirements.txt` de un servicio puede pasar desapercibida en local y fallar recién en el build.
