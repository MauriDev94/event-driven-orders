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
# build it as a workspace member — copying only `app/` is not enough).
# notification-service has no alembic (no DB in Fase 0).
COPY pyproject.toml uv.lock ./
COPY shared ./shared
COPY services/notification-service ./services/notification-service

# Install only this service's runtime deps. `--no-dev` skips the
# [dependency-groups].dev group (pytest/ruff/mypy); `--package notification-service`
# isolates this service's tree from the rest of the workspace.
RUN uv sync --frozen --no-dev --package notification-service

# Put the service venv on PATH so the CMD can call `uvicorn` directly
# without `uv run --package ...` per invocation.
ENV PATH="/app/.venv/bin:$PATH"

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

WORKDIR /app/services/notification-service
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]