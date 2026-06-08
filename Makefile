# Event-Driven Orders — developer task runner
.DEFAULT_GOAL := help

SERVICES := order-service inventory-service notification-service

.PHONY: help up down logs ps build test lint format

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

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

test: ## Run the test suite of every service
	@for svc in $(SERVICES); do \
		echo "==> testing $$svc"; \
		(cd services/$$svc && python -m pytest) || exit 1; \
	done

lint: ## Run ruff over every service and the shared package
	@for svc in $(SERVICES); do \
		echo "==> linting $$svc"; \
		(cd services/$$svc && ruff check .) || exit 1; \
	done
	ruff check shared

format: ## Auto-format every service and the shared package with ruff
	@for svc in $(SERVICES); do \
		(cd services/$$svc && ruff format .); \
	done
	ruff format shared
