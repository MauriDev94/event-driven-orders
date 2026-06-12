#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# Event-Driven Orders — script de re-deploy idempotente para la VM de producción.
#
# Uso (desde la raíz del repo, en la VM):
#   ./deploy/deploy.sh
#
# Requiere: .env.production en la raíz del repo (ver DEPLOY.md sección 3).
# ----------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env.production ]; then
  echo "Error: falta .env.production en la raíz del repo. Ver DEPLOY.md sección 3." >&2
  exit 1
fi

echo "==> git pull"
git pull --ff-only

echo "==> docker compose up -d --build"
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production up -d --build

echo "==> estado de los servicios"
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production ps
