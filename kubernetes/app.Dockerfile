FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY drizzle/ drizzle/
COPY scripts/ scripts/
COPY pipelines/ pipelines/
COPY skills/ skills/
COPY extensions/ extensions/

RUN mkdir -p .work data \
  && chown -R node:node /app/.work /app/data

USER node

ENV DASHBOARD_HOST=0.0.0.0

EXPOSE 8787

CMD ["node", "dist/index.js"]
