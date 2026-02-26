# Gooseherd Sandbox — isolated container for agent runs
#
# Contains all tools needed by pipeline nodes:
#   git, goose CLI, node, curl, gitleaks, chromium (for screenshots)
#
# Usage:
#   docker build -t gooseherd/sandbox:default sandbox/
#   docker run --rm gooseherd/sandbox:default goose --version

FROM node:22-bookworm-slim

# System tools needed by pipeline nodes
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    bzip2 \
    ca-certificates \
    libxcb1 \
    chromium \
    procps \
    findutils \
    sed \
    coreutils \
  && rm -rf /var/lib/apt/lists/*

# Goose CLI (AI coding agent by Block)
RUN curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh \
    | CONFIGURE=false GOOSE_BIN_DIR=/usr/local/bin bash \
  && goose --version

# Gitleaks (secret scanner)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then GOOS_ARCH="x64"; else GOOS_ARCH="$ARCH"; fi && \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_${GOOS_ARCH}.tar.gz" \
    | tar xz -C /usr/local/bin gitleaks \
  && gitleaks version || true

# Playwright for screenshots (uses system chromium, skip bundled browser download)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_PATH=/usr/local/lib/node_modules
RUN npm install -g playwright@latest

# CEMS MCP (memory tools for Goose agent)
# Install uv (Python package manager), then install cems package which provides cems-mcp binary
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
  && export PATH="$HOME/.local/bin:$PATH" \
  && uv tool install "cems @ git+https://github.com/chocksy/cems.git" --force \
  && ln -sf $HOME/.local/bin/cems-mcp /usr/local/bin/cems-mcp \
  && cems-mcp --help || true
ENV PATH="/root/.local/bin:$PATH"

# Goose headless mode (no system keyring)
ENV GOOSE_DISABLE_KEYRING=1

# Copy sandbox-compatible dummy agent for E2E testing
COPY sandbox-dummy-agent.sh /usr/local/bin/sandbox-dummy-agent.sh
RUN chmod +x /usr/local/bin/sandbox-dummy-agent.sh

WORKDIR /work

# Keep container alive for exec commands
CMD ["sleep", "infinity"]
