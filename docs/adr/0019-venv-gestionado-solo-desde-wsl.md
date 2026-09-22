# ADR-0019 — El venv del workspace se gestiona solo desde WSL, no desde Windows

**Estado:** Aceptada · **Fecha:** 2026-09-22 · **Ámbito:** `.venv/` (workspace venv de uv), flujo de desarrollo local en máquinas Windows

## Contexto

Desde la migración a `pyproject.toml` + uv workspaces ([PR #38](https://github.com/MauriDev94/event-driven-orders/pull/38)) el proyecto tiene **un único `.venv/` en la raíz del repo**, gestionado por `uv sync`. Sobre Linux y macOS eso es trivial — un proceso, un filesystem.

Sobre **Windows + WSL** la cosa se complica porque el repo vive en un bind-mount de Windows (`/mnt/d/...` en WSL, `D:\...` en Windows), y ambos lados ven el mismo `.venv/`:

- `uv` desde WSL escribe el venv siguiendo la convención Linux: incluye un symlink `lib64 -> lib`, paths en estilo POSIX, posiblemente `bin/python3` (sin `.exe`).
- `uv` desde Windows ve ese `lib64` como un directorio que no entiende, e intenta eliminarlo cuando re-sincroniza. Falla con `failed to remove file \\?\D:\...\lib64: Acceso denegado`.
- Resultado: el `.venv/` queda en un estado mixto que ninguno de los dos `uv` puede reescribir limpiamente.

El "workaround" que descubrí mientras metía los forcing tests (PR #40) fue borrar el `.venv/` desde PowerShell antes de cada re-sync:

```powershell
Remove-Item .venv -Recurse -Force
uv sync --package shared
```

Funcionaba porque PowerShell borra el symlink `lib64` como un nodo cualquiera y uv puede reconstruir el venv desde cero. Pero es frágil: depende de saber el truco, de tener acceso a Windows, y deja al venv en un estado inconsistente entre sincronizaciones. No es una regla operativa, es una receta.

Mientras tanto, los **forcing tests de retry/DLQ** ([PR #40](https://github.com/MauriDev94/event-driven-orders/pull/40), issue [#39](https://github.com/MauriDev94/event-driven-orders/issues/39)) requieren Docker — y Docker en máquinas Windows de este repo corre dentro de WSL ([ADR-0008](0008-tests-contra-postgres-real.md) ya documenta este setup para Postgres). O sea: las pruebas que necesitan el venv + Docker solo se corren desde WSL, no desde Windows. La única razón para tocar el venv desde Windows era verificar lint/format, lo cual se puede hacer con `uv run` desde WSL sin perder nada.

## Decisión

**El `.venv/` del workspace se gestiona exclusivamente desde WSL.**

- **Windows (PowerShell / editores / asistentes IA): solo edición de archivos.** Nada de `uv sync`, `uv run`, `pip install`, `python -m venv` sobre el `.venv/` del repo. Los editores que autocompletan desde el venv deben apuntar a `.wsl-venv/` o a otra venv local de la máquina Windows que no sea la del repo (ver [Alternativas](#alternativas) — segunda opción).
- **WSL (Ubuntu): dueña del venv.** Comando canónico:
  ```bash
  export PATH=$HOME/.local/bin:$PATH
  cd /mnt/d/Proyectos/python/clean/event-driven-orders
  uv sync --package shared        # (o --all-packages, según el scope)
  uv run --package shared pytest -m integration shared/tests/integration/
  ```
- **Verificación de lint/format desde Windows** (cuando un editor o un asistente lo necesita): pasar por WSL, no tocar `.venv/` directamente:
  ```powershell
  wsl bash -c "cd /mnt/d/Proyectos/python/clean/event-driven-orders && uv run --package shared ruff check shared/"
  ```
- **Recuperación si el `.venv/` quedó en estado inconsistente** (tocado por ambos lados en una sesión anterior): desde WSL, no desde Windows:
  ```bash
  export PATH=$HOME/.local/bin:$PATH
  cd /mnt/d/Proyectos/python/clean/event-driven-orders
  rm -rf .venv
  uv sync --package shared
  ```
  El `rm -rf` desde Linux entiende symlinks. El equivalente en PowerShell (`Remove-Item -Recurse -Force`) también funciona pero deja el sistema de archivos en un estado más confuso; preferible que solo lo toque WSL.

Esta regla **se solapa intencionalmente** con [ADR-0017](0017-tests-e2e-solo-local-no-en-ci.md) (e2e corre solo local) y [ADR-0008](0008-tests-contra-postgres-real.md) (tests contra Postgres real requieren Docker): la misma motivación — *no todo necesita correr en todos lados* — pero aplicada al venv.

## Consecuencias

**Positivas**

- El `.venv/` lo maneja un solo proceso (uv desde WSL) por sesión. Cero conflicto de filesystem.
- El editor o asistente que trabaja desde Windows no rompe el venv aunque corra `ruff check` o similares vía shell-out a WSL.
- La regla es trivial de explicar y de verificar: si tu comando empieza con `uv sync` o `uv run` y lo estás corriendo desde PowerShell, **no**.
- Si en el futuro se agrega otro tipo de test que requiera Docker (Redis, Elasticsearch, lo que sea), hereda gratis la regla "corre desde WSL".

**Negativas / limitaciones**

- **Una máquina Windows sin WSL no puede correr la suite** — los forcing tests, los integration tests con `testcontainers`, los e2e, y desde ahora también el ciclo "modificar + verificar" más básico. Esto es aceptable: el repo ya asumía WSL para Docker ([ADR-0008](0008-tests-contra-postgres-real.md)).
- **Asistentes IA / editores que autocompletan desde el venv del repo**: si esperan encontrar `.venv/` en la máquina Windows, no van a funcionar correctamente. Hay que configurarles una venv local de la máquina (`python -m venv .editor-venv`) o apuntarlos a `.wsl-venv/` (la venv previa del usuario, ver [Alternativas](#alternativas)).
- **Linting desde el editor en Windows**: el LSP de Python o el formateador on-save debe usar `ruff` instalado en el sistema Windows o shell-out a WSL; no puede usar el `ruff` dentro del `.venv/` del repo (porque ese `.venv/` no debería existir del lado Windows).
- **`pre-commit` hooks** que corran `uv run ruff ...`: deben pasar por WSL o instalarse vía `pip install --user` en Windows; no deben usar el `.venv/` del workspace.

## Alternativas

**Dos venvs separados con `UV_PROJECT_ENVIRONMENT`.** Configurar `UV_PROJECT_ENVIRONMENT=.wsl-venv` desde WSL y `UV_PROJECT_ENVIRONMENT=.windows-venv` desde Windows. Resuelve el conflicto a nivel filesystem pero no elimina la confusión sobre cuál lado es dueño de qué — y mete config en `opencode.json` o scripts de shell que hay que mantener. Descartado por agregar superficie sin simplificar el modelo mental.

**Aceptar el workaround `Remove-Item .venv` y documentarlo.** Fue la receta que existió durante la sesión del PR #40. Funciona pero es frágil, depende de saber el truco y de acceso a Windows. No escala: cada vez que aparezca un nuevo flujo que toque el venv desde Windows (otro asistente, otro editor, otro contributor) hay que explicar el workaround de nuevo. Descartado por la misma razón por la que se prefiere una regla explícita a un truco implícito.

**Que cada servicio tenga su propio venv, gestionado de forma independiente.** Más cerca del modelo pre-#38. Pero pierde los beneficios del workspace de uv (resolución cruzada de `shared` como editable, lock único, etc.) y abre la puerta a derivas de versión entre venvs. Descartado por reintroducir el problema que la migración a workspaces resolvió.
