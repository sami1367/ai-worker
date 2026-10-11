# syntax=docker/dockerfile:1.7

FROM node:22-bookworm AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NUXT_TELEMETRY_DISABLED=1
RUN pnpm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq util-linux openssh-client rsync \
      gh \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN useradd --create-home --uid 10001 --shell /bin/bash appuser \
    && mkdir -p /data/config /data/workspaces /data/logs /data/state /app \
    && chown -R appuser:appuser /data /app

# Provider CLIs are optional at image build time; document secure install/auth.
# Attempt reproducible cursor-agent / claude installs when network allows during build.
# Failures here must not break the image — binaries can be mounted or installed later.
RUN set -eux; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg >/dev/null 2>&1 || true

COPY --from=build --chown=appuser:appuser /app/.output ./.output
COPY --from=build --chown=appuser:appuser /app/package.json ./package.json
COPY --from=build --chown=appuser:appuser /app/database ./database
COPY --from=build --chown=appuser:appuser /app/scripts ./scripts
COPY --from=build --chown=appuser:appuser /app/worker ./worker
COPY --from=build --chown=appuser:appuser /app/node_modules ./node_modules

RUN chmod +x /app/worker/*.sh /app/scripts/*.sh 2>/dev/null || true \
    && ln -sf /app/worker /data/config/worker-src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    AI_WORKER_BASE_DIR=/data/config \
    WORKSPACE_ROOT=/data/workspaces \
    LOGS_DIR=/data/logs \
    STATE_DIR=/data/state \
    CONFIG_DIR=/data/config \
    NUXT_TELEMETRY_DISABLED=1

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/v1/health" || exit 1

CMD ["node", ".output/server/index.mjs"]
