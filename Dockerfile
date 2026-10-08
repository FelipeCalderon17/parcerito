FROM node:24-bookworm-slim

# Tools the agents need inside the container: git + GitHub CLI for repos and PRs,
# ripgrep for fast search, and a basic toolchain so they can run most projects' tests.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg ripgrep python3 make g++ \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Everything that must survive a redeploy lives on the /data volume.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    CODEX_HOME=/data/codex \
    CLAUDE_CONFIG_DIR=/data/claude

ENTRYPOINT ["/entrypoint.sh"]
