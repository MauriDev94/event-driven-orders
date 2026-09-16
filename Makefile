# Event-Driven Orders — developer task runner
.DEFAULT_GOAL := help

SERVICES := order-service inventory-service notification-service

# Single shared venv at the repo root; `uv sync` populates it from the
# workspace pyproject.toml + uv.lock. All commands run via `uv run`, which
# resolves packages against the workspace, so we get reproducible cross-platform
# behaviour without OS-specific paths.
UV := uv

.PHONY: help install up down logs ps build test lint format e2e

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Create the shared .venv and install every workspace member (runtime + dev)
	$(UV) sync

up: ## Start the full stack (infra + services) in the background
	docker compose up -d --build

down: ## Stop the stack and remove containers
	docker compose down

logs: ## Tail logs from all services
	docker compose logs -f

ps: ## Show running containers and health
	docker compose ps

build: ## Build all service images
	docker compose build

test: ## Run every service's test suite with coverage (enforces the per-service gate)
	@for svc in $(SERVICES); do \
		echo "==> testing $$svc"; \
		(cd services/$$svc && $(UV) run pytest -q --cov=app --cov-report=term-missing) || exit 1; \
	done
	@echo "==> testing shared"
	@(cd shared && $(UV) run --package shared pytest -q) || exit 1

lint: ## Lint + format check + type check every service and lint the shared package
	@for svc in $(SERVICES); do \
		echo "==> linting $$svc"; \
		(cd services/$$svc && $(UV) run ruff check . && $(UV) run ruff format --check . && $(UV) run mypy app) || exit 1; \
	done
	$(UV) run --package shared ruff check shared
	$(UV) run --package shared ruff format --check shared

format: ## Auto-format every service and the shared package with ruff
	@for svc in $(SERVICES); do \
		(cd services/$$svc && $(UV) run ruff format .); \
	done
	$(UV) run --package shared ruff format shared

e2e: ## Run e2e tests against the real stack (requires `make up` first)
	$(UV) run --package event-driven-orders-e2e pytest tests/e2e -q -m e2e