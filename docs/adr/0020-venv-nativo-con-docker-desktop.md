# ADR-0020 — El venv del workspace lo gestiona uv nativo del sistema operativo, con Docker Desktop

**Estado:** Aceptada · **Fecha:** 2026-10-28 · **Ámbito:** `.venv/` (workspace venv de uv), flujo de desarrollo local · **Reemplaza a:** [ADR-0019](0019-venv-gestionado-solo-desde-wsl.md)

## Contexto

[ADR-0019](0019-venv-gestionado-solo-desde-wsl.md) dejó el `.venv/` en manos de WSL porque, en el equipo de entonces, Docker solo funcionaba dentro de WSL y el repo vivía en un bind-mount de Windows (`D:\...` ⇄ `/mnt/d/...`). Correr `uv` desde los dos lados sobre el mismo `.venv/` lo rompía (el symlink `lib64 -> lib` que crea uv en Linux no se puede borrar desde Windows).

El proyecto se movió a un equipo nuevo donde ese supuesto ya no se cumple:

- **Docker Desktop corre nativo en Windows** y expone el daemon por named pipe. `testcontainers` lo usa sin pasar por WSL; el SDK `docker` trae `pywin32` como dependencia condicional y ya está en `uv.lock`.
- **uv está instalado en Windows** y el repo vive en NTFS (`C:\Users\mauri\Desktop\main\dev\projects\event-driven-orders`). Desde WSL se vería por `/mnt/c/...`, un filesystem 9p notablemente más lento.
- Los editores y los asistentes (Claude Code) corren en Windows. Con la regla de ADR-0019 cada comando tenía que envolverse en `wsl bash -lc "cd /mnt/... && uv run ..."`, y las rutas del ADR apuntaban a un disco que ya no existe.

Verificado en este equipo (Windows 11, Docker Desktop 29.8, uv 0.13.1, Python 3.12.15 gestionado por uv):

- `uv sync --all-packages --frozen` crea `.venv/` con layout Windows (`Scripts/`, `Lib/`) y `uv lock --check` confirma que el lock está al día.
- `ruff check`, `ruff format --check` y `mypy app` pasan en los tres servicios y en `shared/`.
- Los tests de integración levantan `postgres:16-alpine` (más el contenedor `ryuk` de testcontainers) y `rabbitmq:3.13-management` sin configuración extra. El forcing test rápido de retry/DLQ pasa en ~15 s, frente a ~70 s en el setup WSL anterior.

## Decisión

**El `.venv/` lo gestiona el uv nativo del sistema operativo donde vive el clone, y los tests usan el Docker de ese mismo sistema.** En el equipo de desarrollo actual eso significa Windows + Docker Desktop.

- Comandos de uv directo desde PowerShell o Git Bash, en la raíz del repo: `uv sync --all-packages`, `uv run --package <paquete> ...`.
- **La regla de fondo de ADR-0019 se mantiene: un solo dueño por clone.** No se corre `uv` sobre este `.venv/` desde WSL. Si alguna vez se quiere trabajar desde WSL, se clona el repo dentro del filesystem de Linux (`~/...`) con su propio `.venv/`, no se comparte el de Windows.
- `.python-version` fija **3.12** en la raíz del workspace para que uv elija la misma versión que CI (`uv python install 3.12`) y los Dockerfiles (`python:3.12-slim`). Sin él, uv tomaba el intérprete más nuevo disponible en la máquina.
- Docker Desktop tiene que estar corriendo antes de los tests de integración, de `make up` y de `make e2e`.
- Se elimina `.wsl-smoke-test.py`, que solo servía para validar la cadena venv de WSL ⇄ Docker; los tests de integración cumplen ese rol.

## Consecuencias

**Positivas**

- Un solo entorno, sin envolver comandos en WSL: editor, asistente, tests y Docker ven el mismo `.venv/`.
- Los tests que usan contenedores corren más rápido (sin filesystem 9p ni la VM de WSL de por medio).
- La regla vale igual para Linux y macOS: uv nativo + Docker nativo, que era el caso trivial de ADR-0019.

**Negativas / limitaciones**

- `make` no viene con Windows ni con Git for Windows. Hasta que se instale (por ejemplo `winget install ezwinports.make`), los targets del `Makefile` se reemplazan por los comandos `uv` que envuelven (están en `CLAUDE.md`).
- En Windows una conexión TCP rechazada tarda ~2 s (Windows reintenta el SYN), contra un rechazo instantáneo en Linux. Los tests que arrancan el lifespan real sin broker pagan eso en cada intento de `connect_with_retry`, además del backoff (~35 s por arranque). Peor aún, esa demora deja la cancelación del shutdown en medio de un intento de conexión y expone un bug de `RabbitMQConnection.connect()` que cuelga el proceso: hasta que se corrija, las suites de integración de los servicios no terminan en Windows. Ambos quedan registrados en [`docs/roadmap.md`](../roadmap.md) (paso 0).
- Un `.venv/` creado en Windows no sirve desde WSL ni al revés. Cambiar de lado exige borrarlo y volver a sincronizar desde el lado nuevo.

## Alternativas

**Mantener ADR-0019 y actualizar solo las rutas a `/mnt/c/...`.** Conserva un setup que ya no hace falta: el motivo original (Docker solo dentro de WSL) desapareció, y suma la lentitud de `/mnt/c` y el wrapper `wsl bash -lc` en cada comando. Descartado.

**Clonar el repo dentro del filesystem de WSL (`~/event-driven-orders`).** Es la forma rápida de usar WSL, pero el editor y Claude Code corren en Windows y tendrían que trabajar por `\\wsl$\...`, y habría dos copias del repo en el equipo. Descartado mientras el resto del workspace (`dev/`) viva en Windows.

**Dos venvs con `UV_PROJECT_ENVIRONMENT` (`.windows-venv` / `.wsl-venv`).** Mismo motivo de descarte que en ADR-0019: agrega configuración sin simplificar el modelo mental.
