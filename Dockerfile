# EmberForge shared image — used by api, orchestrator, labs-worker, tts-worker, veo3-worker.
# render-worker uses Dockerfile.render (includes ffmpeg).
#
# The APP_TARGET build arg / env var selects which pnpm workspace runs:
#   docker build --build-arg APP_TARGET=api .
#   fly deploy -c infra/fly/api.fly.toml
#
# Fly.io reads APP_TARGET from each app's [env] block in its fly.toml.

FROM node:20-bookworm-slim

# minimal system deps for HTTPS + healthchecks
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Install deps first so layer is cached across source changes
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/workers/labs-worker/package.json apps/workers/labs-worker/
COPY apps/workers/tts-worker/package.json apps/workers/tts-worker/
COPY apps/workers/veo3-worker/package.json apps/workers/veo3-worker/
COPY apps/workers/render-worker/package.json apps/workers/render-worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/queue/package.json packages/queue/
COPY packages/storage/package.json packages/storage/
COPY packages/ai-clients/package.json packages/ai-clients/
COPY packages/prompt-engine/package.json packages/prompt-engine/
COPY packages/timeline-engine/package.json packages/timeline-engine/
COPY packages/render/package.json packages/render/

# If pnpm-lock.yaml exists use frozen install, otherwise generate one
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi

# Now copy actual source — only this layer rebuilds on code changes
COPY apps apps
COPY packages packages
COPY infra infra
COPY scripts scripts

ENV NODE_ENV=production
ENV APP_TARGET=api

# tini for proper signal handling so BullMQ workers shut down cleanly
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "pnpm --filter @emberforge/$APP_TARGET start"]
