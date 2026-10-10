# The eval's run environment: pinned Node, the SDK and its bundled Claude Code
# from package-lock.json, this checkout's code, and no Claude configuration.
# Built and run by container/run.sh; results come back through a mount.
FROM node:24.21.0-bookworm-slim

# git is only for the version record when run.sh does not pass one; tzdata
# lets TZ=Asia/Tokyo (set per run by eval/env.ts) resolve.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tzdata && rm -rf /var/lib/apt/lists/*

WORKDIR /work
COPY package.json package-lock.json ./
# Exact versions from the lockfile: @anthropic-ai/claude-agent-sdk 0.3.295
# ships Claude Code 2.1.295 as its native binary.
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY . .

# An empty HOME and config dir; eval/run.ts gives each run fresh ones as well.
ENV HOME=/tmp/home CLAUDE_CONFIG_DIR=/tmp/home/.claude NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false LANG=C.UTF-8 TZ=Asia/Tokyo
RUN mkdir -p /tmp/home/.claude && chmod -R 777 /tmp/home

CMD ["npx", "tsx", "eval/run.ts", "--env-only"]
