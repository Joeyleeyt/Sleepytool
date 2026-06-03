# EmberForge lean image (no ffmpeg) — builds any of the non-render workspaces.
#
# NOTE: the live Fly deployment (infra/fly/sleepytool.fly.toml) builds BOTH its
# process groups from Dockerfile.render, so this lean image is currently unused
# by deploys. It's kept as the slim build path (e.g. if the `workers` group is
# ever split into its own single-image app). Web + API ship on Vercel.
#
# The APP_TARGET build arg / env var selects which pnpm workspace the default
# CMD runs (sleepytool overrides this per process group via [processes]):
#   docker build --build-arg APP_TARGET=orchestrator .

FROM node:20-bookworm-slim

# minimal system deps for HTTPS + healthchecks
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Install deps first so layer is cached across source changes
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* turbo.json tsconfig.base.json ./
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/workers/all/package.json apps/workers/all/
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
ENV APP_TARGET=orchestrator

# tini for proper signal handling so BullMQ workers shut down cleanly
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "pnpm --filter @emberforge/$APP_TARGET start"]
