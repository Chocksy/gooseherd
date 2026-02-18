# ── build stage ──────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── runtime stage ────────────────────────────────────────────
FROM node:22-bookworm-slim

# System deps:
#   git            – executor git operations (clone, push, etc.)
#   curl           – download goose binary
#   bzip2          – decompress goose .tar.bz2 archive
#   ca-certificates – HTTPS for git + API calls
#   libxcb1        – runtime dependency of the goose Rust binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    bzip2 \
    ca-certificates \
    libxcb1 \
  && rm -rf /var/lib/apt/lists/*

# Install Goose CLI (AI coding agent by Block)
# CONFIGURE=false skips interactive setup; GOOSE_BIN_DIR puts it on PATH
RUN curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh \
    | CONFIGURE=false GOOSE_BIN_DIR=/usr/local/bin bash \
  && goose --version

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY scripts/ scripts/

RUN mkdir -p .work data

# Goose requires this in headless/container environments (no system keyring)
ENV GOOSE_DISABLE_KEYRING=1
# Dashboard must bind to all interfaces inside a container
ENV DASHBOARD_HOST=0.0.0.0

EXPOSE 8787

CMD ["node", "dist/index.js"]
