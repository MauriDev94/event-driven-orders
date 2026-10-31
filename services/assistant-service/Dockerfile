# Build context is the REPO ROOT (see docker-compose.yml + ADR-0015), like the
# Python services, so compose and CI build every image the same way. Only this
# service's directory is copied: it shares no code with the uv workspace.

# openssl lets Prisma detect the platform and pick its schema engine (the
# binary `prisma migrate deploy` runs). npm ci downloads it in each stage below.
FROM node:24-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Full install, `prisma generate` (the client is gitignored) and `nest build`.
FROM base AS build
COPY services/assistant-service/package.json services/assistant-service/package-lock.json ./
RUN npm ci
COPY services/assistant-service/ ./
RUN npm run build

# Runtime dependencies only. `prisma` is one of them: the container migrates
# its own database before starting (ADR-0016).
FROM base AS prod-deps
COPY services/assistant-service/package.json services/assistant-service/package-lock.json ./
RUN npm ci --omit=dev

FROM base
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# package.json carries "type": "module"; prisma7.config.ts and prisma/ are what
# `migrate deploy` reads.
COPY --chown=node:node services/assistant-service/package.json services/assistant-service/prisma7.config.ts ./
COPY --chown=node:node services/assistant-service/prisma ./prisma
USER node

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Apply pending migrations, then start the API and the consumer. depends_on
# waits for Postgres to be healthy in compose. `exec` makes node PID 1 so it
# gets SIGTERM and Nest's shutdown hooks (broker and Prisma close) run.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node dist/main.js"]
