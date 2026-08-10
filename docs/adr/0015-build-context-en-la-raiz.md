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

**Mitigada — el peso del context (`.dockerignore` en la raíz, 2026-08-09)**

El context sigue siendo todo el repo, pero ya no viaja entero. Medido con el builder clásico, que envía y reporta el context completo en cada build:

| | Context enviado al daemon | Transferencia |
|---|---|---|
| Sin `.dockerignore` | 291.7 MB | ~175 s |
| Con `.dockerignore` | 649.8 kB | < 1 s |

Eso ocurre **una vez por servicio**: tres veces en cada `docker compose build`.

El costo no era sólo de build. `COPY shared ./shared` no filtra nada, así que los caches que vivían dentro de `shared/` terminaban **en las imágenes desplegadas**: 13 MB de `.mypy_cache` más `.pytest_cache`, `.ruff_cache` y decenas de `__pycache__` en los tres servicios. Al filtrarlos, las imágenes bajaron 25 MB cada una (`order` e `inventory` 267 → 242 MB, `notification` 228 → 203 MB).

**Los patrones anidados van con `**/`.** `.dockerignore` no es `.gitignore`: Docker evalúa cada patrón contra la ruta relativa a la raíz del context, sin el "match en cualquier nivel" de git. Un `.mypy_cache/` copiado tal cual desde `.gitignore` excluye sólo el de la raíz (12 MB) y deja pasar los cuatro de `shared/` y `services/*/` (70 MB). Ningún build falla por eso — la imagen simplemente sale gorda.

**Negativas / limitaciones**

- El context sigue siendo **todo el repo**. Cada herramienta nueva que deje un cache en el árbol viajará al daemon —y, si cae bajo `shared/` o `services/*/app/`, también a la imagen— hasta que alguien agregue su patrón al `.dockerignore`. Nada lo detecta automáticamente: el síntoma es una imagen gorda, no un build roto.
- `make install` crea un `.venv` **compartido** para desarrollo local, que no refleja el aislamiento real de las imágenes: una dependencia que falta en el `requirements.txt` de un servicio puede pasar desapercibida en local y fallar recién en el build.
