# Build context is the REPO ROOT (see docker-compose.yml + ADR-0015) so the
# uv workspace files (`pyproject.toml`, `uv.lock`, `shared/`, and this
# service's source) are all available at build time.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# uv ships as a single static binary; pinned for reproducibility.
RUN pip install --no-cache-dir uv==0.12.5

WORKDIR /app

RUN groupadd --system appgroup && useradd --system --gid appgroup appuser

# Copy the uv workspace context: root metadata, shared package source, and
# this service's full directory (uv needs the service's pyproject.toml to
# build it as a workspace member — copying only `app/` and `alembic.ini`
# is not enough).
COPY pyproject.toml uv.lock ./
COPY shared ./shared
COPY services/order-service ./services/order-service

# Install only this service's runtime deps. `--no-dev` skips the
# [dependency-groups].dev group (pytest/ruff/mypy); `--package order-service`
# isolates this service's tree from the rest of the workspace.
RUN uv sync --frozen --no-dev --package order-service

# Put the service venv on PATH so the CMD can call `alembic` and `uvicorn`
# directly without `uv run --package ...` per invocation.
ENV PATH="/app/.venv/bin:$PATH"

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

# Apply pending migrations (the orders table must exist before serving), then
# start the API. depends_on waits for Postgres to be healthy in compose.
# Run alembic from the service directory because it reads alembic.ini from
# cwd (the relative path in the config is `app/core/data/source/local/alembic/`).
WORKDIR /app/services/order-service
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]