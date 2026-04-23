ARG BASE_IMAGE=node:22-bookworm-slim
ARG SANDBOX_BASE_IMAGE=435747240845.dkr.ecr.us-east-1.amazonaws.com/services/gooseherd/sandbox:latest
ARG INSTALL_BROWSER_VERIFY=false

FROM ${BASE_IMAGE} AS base
WORKDIR /app

FROM base AS builder

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

FROM base AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ "$INSTALL_BROWSER_VERIFY" = "true" ]; then \
      npm ci --omit=dev; \
    else \
      npm pkg delete optionalDependencies.@browserbasehq/stagehand optionalDependencies.playwright; \
      npm install --package-lock-only --ignore-scripts; \
      npm ci --omit=dev --omit=optional; \
    fi

FROM base AS app

ENV DASHBOARD_HOST=0.0.0.0

COPY --from=deps --chown=node:node /app/node_modules/ node_modules/
COPY --from=builder --chown=node:node /app/dist/ dist/
COPY --chown=node:node drizzle/ drizzle/
COPY --chown=node:node scripts/ scripts/
COPY --chown=node:node pipelines/ pipelines/
COPY --chown=node:node skills/ skills/
COPY --chown=node:node extensions/ extensions/

USER node

VOLUME /app/work
VOLUME /app/data

EXPOSE 8787

CMD ["node", "dist/index.js"]

FROM ${SANDBOX_BASE_IMAGE} AS runner

ENV WORK_ROOT=/app/work
ENV DASHBOARD_ENABLED=false
ENV OBSERVER_ENABLED=false
ENV SUPERVISOR_ENABLED=false

USER root
WORKDIR /app

COPY --from=deps --chown=gooseherd:gooseherd /app/node_modules/ node_modules/
COPY --from=builder --chown=gooseherd:gooseherd /app/dist/ dist/
COPY --chown=gooseherd:gooseherd pipelines/ pipelines/
COPY --chown=gooseherd:gooseherd scripts/ scripts/

VOLUME /app/work

USER gooseherd

CMD ["node", "dist/runner/index.js"]
