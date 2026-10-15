# syntax=docker/dockerfile:1.7

FROM node:22-bookworm AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm AS build
ARG APP_VERSION=1.0.0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NUXT_TELEMETRY_DISABLED=1 \
    APP_VERSION=${APP_VERSION}
RUN pnpm run build

FROM node:22-bookworm-slim AS runner
ARG APP_VERSION=1.0.0
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq util-linux openssh-client rsync \
      python3 \
      bubblewrap \
      gh \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN useradd --create-home --uid 10001 --shell /bin/bash appuser \
    && mkdir -p /data/config /data/workspaces /data/logs /data/state /app \
    && chown -R appuser:appuser /data /app

COPY --from=build --chown=appuser:appuser /app/.output ./.output
COPY --from=build --chown=appuser:appuser /app/package.json ./package.json
COPY --from=build --chown=appuser:appuser /app/database ./database
COPY --from=build --chown=appuser:appuser /app/scripts ./scripts
COPY --from=build --chown=appuser:appuser /app/worker ./worker
COPY --from=build --chown=appuser:appuser /app/node_modules ./node_modules

RUN chmod +x /app/worker/*.sh /app/scripts/*.sh /app/scripts/lib/*.sh 2>/dev/null || true \
    && ln -sf /app/worker /data/config/worker-src

# Install Cursor Agent + Claude Code + Codex + Gemini + CodeGraph CLIs into the image
# (required for worker + health checks). Auth secrets are NOT baked in — connect keys
# from the Providers UI (or env vars). CodeGraph agent MCP wiring runs at worker start.
ENV AI_CLI_HOME=/home/appuser
RUN bash /app/scripts/install-ai-clis.sh \
    && chown -R appuser:appuser /home/appuser

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    APP_VERSION=${APP_VERSION} \
    NUXT_PUBLIC_APP_VERSION=${APP_VERSION} \
    AI_WORKER_BASE_DIR=/data/config \
    WORKSPACE_ROOT=/data/workspaces \
    LOGS_DIR=/data/logs \
    STATE_DIR=/data/state \
    CONFIG_DIR=/data/config \
    NUXT_TELEMETRY_DISABLED=1 \
    HOME=/home/appuser \
    PATH=/home/appuser/.local/bin:/home/appuser/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/v1/health" || exit 1

# Load/persist/validate secrets from env or /data/config/app-secrets.env
ENTRYPOINT ["bash", "/app/scripts/app-entrypoint.sh"]
CMD ["node", ".output/server/index.mjs"]
