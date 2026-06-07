# Event-Driven Orders — developer task runner
.DEFAULT_GOAL := help

SERVICES := order-service inventory-service notification-service

# Shared local dev venv at the repo root. The venv is for DX (one place to run
# ruff/mypy/pytest across all services); Docker still uses each service's own
# requirements.txt for runtime isolation.
VENV := .venv
ifeq ($(OS),Windows_NT)
    VENV_PY := $(VENV)/Scripts/python
else
    VENV_PY := $(VENV)/bin/python
endif

.PHONY: help install up down logs ps build test lint format

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Create the shared .venv and install every service's deps (runtime + dev)
	python -m venv $(VENV)
	$(VENV_PY) -m pip install --upgrade pip
	@for svc in $(SERVICES); do \
		echo "==> installing $$svc (runtime + dev)"; \
		$(VENV_PY) -m pip install -r services/$$svc/requirements-dev.txt || exit 1; \
	done
	@echo ""
	@echo "Done. Activate the venv:"
	@echo "  Windows : source $(VENV)/Scripts/activate"
	@echo "  Unix    : source $(VENV)/bin/activate"

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

test: ## Run every service's test suite with coverage (enforces the gate)
	@for svc in $(SERVICES); do \
		echo "==> testing $$svc"; \
		(cd services/$$svc && python -m pytest -q --cov=app --cov-report=term-missing) || exit 1; \
	done

lint: ## Lint + format check + type check every service and lint the shared package
	@for svc in $(SERVICES); do \
		echo "==> linting $$svc"; \
		(cd services/$$svc && ruff check . && ruff format --check . && mypy app) || exit 1; \
	done
	ruff check shared

format: ## Auto-format every service and the shared package with ruff
	@for svc in $(SERVICES); do \
		(cd services/$$svc && ruff format .); \
	done
	ruff format shared
