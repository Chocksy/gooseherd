# ── build stage ──────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

ARG INSTALL_BROWSER_VERIFY=false

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ "$INSTALL_BROWSER_VERIFY" = "true" ]; then \
      npm ci; \
    else \
      npm pkg delete optionalDependencies.@browserbasehq/stagehand optionalDependencies.playwright; \
      npm install --package-lock-only --ignore-scripts; \
      npm ci --omit=optional; \
    fi

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── runtime stage ────────────────────────────────────────────
FROM node:22-bookworm-slim

ARG INSTALL_BROWSER_VERIFY=false

# System deps:
#   git            – pipeline git operations (clone, push, etc.)
#   curl           – health checks, API calls
#   ca-certificates – HTTPS for git + API calls
#   chromium       – headless browser for Stagehand (optional)
#   ffmpeg         – encode CDP screencast frames → mp4 (optional)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    gosu \
  && if [ "$INSTALL_BROWSER_VERIFY" = "true" ]; then \
       apt-get install -y --no-install-recommends chromium ffmpeg; \
     fi \
  && rm -rf /var/lib/apt/lists/*

# Stagehand launches Chromium in main process — use system package, skip bundled download
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install pi-agent (AI coding agent)
RUN npm install -g @mariozechner/pi-coding-agent \
  && pi --version

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ "$INSTALL_BROWSER_VERIFY" = "true" ]; then \
      npm ci --omit=dev; \
    else \
      npm pkg delete optionalDependencies.@browserbasehq/stagehand optionalDependencies.playwright; \
      npm install --package-lock-only --ignore-scripts; \
      npm ci --omit=dev --omit=optional; \
    fi

COPY --from=builder /app/dist/ dist/
COPY drizzle/ drizzle/
COPY scripts/ scripts/
COPY pipelines/ pipelines/
COPY skills/ skills/
COPY extensions/ extensions/

# Non-root user for security (entrypoint drops to this user via gosu)
RUN useradd -m -s /bin/bash gooseherd \
  && mkdir -p .work data \
  && chown -R gooseherd:gooseherd .work data

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Dashboard must bind to all interfaces inside a container
ENV DASHBOARD_HOST=0.0.0.0

EXPOSE 8787

# OCI labels — links GHCR package to repo (shows README on package page)
LABEL org.opencontainers.image.source="https://github.com/chocksy/gooseherd"
LABEL org.opencontainers.image.description="Self-hosted AI coding agent orchestrator — herds Goose agents via Slack and opens PRs"
LABEL org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
