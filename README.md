# EmberForge

Cinematic long-form AI documentary video generation platform. Converts a narration transcript into a fully edited cinematic video using Google Veo 3, 69labs.vip, FFmpeg, and Remotion.

## Stack

- **Runtime:** Node.js 20, TypeScript, pnpm + Turborepo
- **API:** Fastify
- **Queue:** BullMQ on Redis
- **DB:** Supabase Postgres (Drizzle ORM)
- **Storage:** Cloudflare R2
- **Deploy:** Fly.io (CPU + GPU pools)
- **Render:** FFmpeg (NVENC) + Remotion

## Two run modes

| Mode | Requires | Pipeline |
|---|---|---|
| **LABS-ONLY** (cheapest, no LLM) | 69labs API key + voice id, Postgres, Redis, R2, ffmpeg | Rule-based segmentation → 69labs image + Ken Burns motion → 69labs TTS → composite → encode |
| **LLM-DRIVEN** (richest, best quality) | + Anthropic key + Veo 3 key | Claude analyzes/segments/classifies → Veo 3 cinematic clips + 69labs b-roll → composite → encode |

Pick a mode by setting `LLM_PROVIDER` and `DISABLE_VEO3` in `.env`.

## LABS-ONLY quick start

Use this when you only have a 69labs.vip API key + voice id.

### Prerequisites

| Need | How |
|---|---|
| Node 20+ | `nvm install 20 && nvm use 20` |
| pnpm 9 | `npm i -g pnpm@9` |
| **Supabase project** | Create one at https://supabase.com → copy the **transaction pooler** URL (port 6543) for `DATABASE_URL` and the **direct connection** URL (port 5432) for migrations |
| Redis 7 (local) | `pnpm infra:up` (uses docker-compose; host port `6381`) |
| ffmpeg / ffprobe | Set `FFMPEG_PATH` / `FFPROBE_PATH` in `.env`, or have them on `PATH` |
| API keys | 69labs.vip + Cloudflare R2 (labs-only mode); add Anthropic + Veo 3 for LLM mode |

### 1. Configure (labs-only minimum)

```bash
cp .env.example .env
```

Fill in only these:

```ini
LLM_PROVIDER=none                # already the default
DISABLE_VEO3=true                # already the default
IMAGE_RATIO=0.2                  # 20% AI images, 80% AI video clips (default)
DEFAULT_VISUAL_TYPE=atmospheric_broll  # seed for the 80% video slots

# Supabase — use the TRANSACTION POOLER (port 6543) at runtime so all 7
# processes share a tiny connection footprint.
DATABASE_URL=postgresql://postgres.<ref>:<URL-ENCODED-PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres

LABS69_API_KEY=your-key-here
LABS69_VOICE_ID=your-voice-id-here

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=emberforge-dev
```

Everything else has working defaults. You do NOT need Anthropic or Veo 3 keys.

Tune the image / video split with `IMAGE_RATIO`: `0.2` = 20% images / 80% video clips (default), `0.5` = even split, `1` = all images, `0` = all video clips. Enforced globally in both labs-only and LLM-driven modes.

### 2. Install + start Redis

```bash
pnpm install
pnpm infra:up      # docker compose up -d  (Redis only — Postgres lives on Supabase)
```

### 3. Apply the DB schema to Supabase

Migrations need the **direct connection** (port 5432) because Supabase's
transaction pooler rejects multi-statement DDL. Run once per fresh Supabase
project; the script is idempotent so re-runs are safe.

```powershell
# PowerShell
$env:DATABASE_URL="postgresql://postgres.<ref>:<URL-ENCODED-PASSWORD>@db.<ref>.supabase.co:5432/postgres"
pnpm db:migrate
```

```bash
# bash
DATABASE_URL="postgresql://postgres.<ref>:<URL-ENCODED-PASSWORD>@db.<ref>.supabase.co:5432/postgres" pnpm db:migrate
```

Look for `[migrate] ok`. After this, leave `.env`'s `DATABASE_URL` pointing at
the pooler URL — the migrate command does **not** overwrite `.env`.

(Optional) Apply RLS policies once you turn on auth:
`psql $DIRECT_URL -f infra/supabase/policies.sql`

### 4. (Optional) Validate your 69labs API shape

```bash
pnpm tsx scripts/smoke-69labs.ts
```

Hits TTS / image / video endpoints once each, prints raw responses, flags any field-name mismatches with [packages/ai-clients/src/labs69.ts](packages/ai-clients/src/labs69.ts).

### 5. Run the stack

```bash
pnpm stack:dev
```

Boots:
- **Web UI + API** on `http://localhost:3000` ← open this (API lives under `/api/v1/*` in the Next.js app)
- Orchestrator + 4 workers in the background

### 6. Submit a transcript

**Easy:** open `http://localhost:3000` → click **New project** → paste a transcript → **Start generating**. The Scene Board fills in as assets generate; the bottom status bar shows live progress + cost.

**CLI alternative:**

```bash
pnpm tsx scripts/submit-transcript.ts ./samples/sample-transcript.txt "Cosmic Origins"
```

The script POSTs the transcript, prints the `projectId`, and polls until status reaches `published` or `failed`. Then fetch the signed URL from the `renders` table.

### 7. Replay a single stage (debugging)

```bash
curl -X POST http://localhost:3000/api/v1/projects/<projectId>/replay/encode
# valid stages: analyze, segment, classify, prompt, generateAssets,
#               buildTimeline, mixAudio, composite, encode, publish
```

Cached assets (R2 + Postgres by `input_hash`) are reused — only the requested stage runs again.

## Pipeline stages

```
INGESTED → ANALYZED → SEGMENTED → CLASSIFIED → PROMPTED
        → GENERATING_ASSETS → ASSETS_READY → TIMELINE_BUILT
        → AUDIO_MIXED → COMPOSITED → ENCODED → PUBLISHED
```

Every stage is idempotent (content-addressed by `input_hash`) and resumable. Re-running a project re-uses cached assets in R2.

## What LABS-ONLY mode produces

For each shot in your transcript (default `IMAGE_RATIO=0.2`):
- **Visual (80% of shots)** — AI-generated video clip via 69labs `/videos/generate`
- **Visual (20% of shots)** — single AI-generated still image via 69labs `/images/generate`, animated with a deterministic Ken Burns push-in / pull-out / pan
- **Audio** — TTS narration using your `LABS69_VOICE_ID`
- **Composition** — color-graded, vignetted, with film grain + ember overlays IF you've seeded `fx-cache/`
- **Final** — H.264 MP4 with burned-in subtitles

Approximate cost per minute of finished video in labs-only mode at default ratio:
- 8 shots/min ≈ 6.4 video clips × ~$0.15 ≈ $0.96 video
- 8 shots/min ≈ 1.6 images × ~$0.02 ≈ $0.03 image
- ~150 words/min TTS @ ~$0.05 = $0.05 voice
- **≈ $1.04/minute, ~$62 for a 1-hour video**

Set `IMAGE_RATIO=1` to fall back to the cheaper all-images mode (~$0.20/min, ~$12/hr).

## What safe-mode skips

| Feature | Safe-mode behavior |
|---|---|
| Auth (JWT) | Disabled — all routes open, projects assigned to `DEV_OWNER_ID` |
| Remotion motion graphics | Disabled — `infographic` / `diagram` / `typography` shots route to atmospheric b-roll instead |
| Music beds | Disabled — output has narration only |
| FX overlays (embers/smoke/grain) | Auto-skipped if `FX_LIBRARY_DIR` is empty |
| NVENC | Defaults to off; software x264/x265 encode |
| RLS policies | Not applied (apply `infra/supabase/policies.sql` once you turn auth on) |

## Deploying to Fly.io

EmberForge ships as six independently-scaled Fly apps from this monorepo:

| App | Image | Purpose |
|---|---|---|
| `emberforge-api` | `Dockerfile` | Fastify HTTP gateway (port 8080, public) |
| `emberforge-orchestrator` | `Dockerfile` | BullMQ flow coordinator + stage handlers |
| `emberforge-labs-worker` | `Dockerfile` | 69labs image/video jobs |
| `emberforge-tts-worker` | `Dockerfile` | 69labs TTS jobs |
| `emberforge-veo3-worker` | `Dockerfile` | Veo 3 jobs (idle when DISABLE_VEO3=true) |
| `emberforge-render-worker` | `Dockerfile.render` | FFmpeg composite + encode (mounted scratch disk) |

### Managed services you'll need

Fly doesn't run your Postgres or Redis. Use:
- **Postgres** — [Supabase](https://supabase.com) (free tier works) or `fly pg create`
- **Redis** — [Upstash](https://upstash.com) (free tier works)
- **R2** — already external (Cloudflare)

Put their connection strings in `.env`:

```ini
DATABASE_URL=postgres://...supabase.co...
REDIS_URL=rediss://default:...@...upstash.io:6379
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=emberforge-prod
```

Run the DB migration against your remote Postgres:

```bash
$env:DATABASE_URL="postgres://...supabase.co..."; pnpm db:migrate
```

### First-time deploy

```powershell
# 1. install flyctl + log in
iwr https://fly.io/install.ps1 -useb | iex
fly auth login

# 2. create the six Fly apps (idempotent)
pnpm fly:create

# 3. push every secret from .env to every app
pnpm fly:secrets

# 4. build + deploy all six apps in sequence
pnpm fly:deploy
```

The API is now public at `https://emberforge-api.fly.dev`. Submit a transcript:

```powershell
$env:EMBERFORGE_API="https://emberforge-api.fly.dev"
pnpm tsx scripts/submit-transcript.ts ./samples/sample-transcript.txt
```

### Incremental deploys

```bash
pnpm fly:deploy:api            # API only
pnpm fly:deploy:orchestrator   # orchestrator only
pnpm fly:deploy:workers        # all four workers
# one specific app:
pwsh scripts/fly/deploy.ps1 -App emberforge-labs-worker
```

### Updating secrets later

```bash
# edit .env, then:
pnpm fly:secrets        # stages on all apps
pnpm fly:deploy         # rolling restart picks up new secrets
```

### Scaling per worker

```bash
# more parallel 69labs throughput
fly scale count 3 --app emberforge-labs-worker

# bigger render machine
fly scale vm performance-4x --app emberforge-render-worker

# GPU render (L40S) + NVENC
fly scale vm l40s --app emberforge-render-worker
fly secrets set NVENC_ENABLED=true --app emberforge-render-worker
```

### Cost notes

- Worker apps `auto_stop_machines = "stop"` → $0 cost when their queue is empty
- `emberforge-api` keeps min 1 machine running for HTTP latency
- `emberforge-orchestrator` keeps min 1 machine running to pick up jobs immediately
- `emberforge-render-worker` performance-2x: ~$0.014/hr while actively encoding
- L40S GPU render: ~$2/hr when running; scale to zero when idle

## Promoting to production (other items)

1. **Auth** — register `@fastify/jwt` back in [apps/api/src/server.ts](apps/api/src/server.ts) and add `preHandler: [app.authenticate]` to routes
2. **Music library** — seed an R2 bucket with mood beds and patch `pickMusicAssetIdForMood` in [packages/timeline-engine/src/builder.ts](packages/timeline-engine/src/builder.ts) to return real asset ids
3. **FX library** — drop alpha-channel ember/smoke/grain loops in `fx-cache/` (paths in [packages/render/src/fxLibrary.ts](packages/render/src/fxLibrary.ts))
4. **Remotion** — build motion-graphics compositions and unblock the `infographic` / `diagram` / `typography` visual types
5. **RLS** — apply `infra/supabase/policies.sql`

## Layout

```
apps/
  api/                  Fastify HTTP gateway
  orchestrator/         BullMQ flow coordinator + stage handlers
  workers/              veo3-, labs-, tts-, render-worker
packages/
  core/                 Shared types + zod schemas
  db/                   Drizzle schema, migrations, repos
  queue/                BullMQ wrappers + flows + rate limiter
  storage/              R2 client + signed URLs
  ai-clients/           Claude / Veo 3 / 69labs SDKs + retry
  prompt-engine/        Prompt builders + visual memory + palettes
  timeline-engine/      EDL builder + transitions + subtitles
  render/               FFmpeg filtergraphs + audio mix + FX library
infra/
  fly/                  Per-app Fly.io configs
  supabase/             SQL bootstrap + RLS policies
  docker/               Worker Dockerfiles
scripts/
  submit-transcript.ts  Convenience client for end-to-end testing
  replay-project.ts     Re-enqueue a single stage
```

## Cost reference (per 2-hour finished video, all providers live)

| Stage | ~Cost |
|---|---|
| Claude analyze + segment (Opus) | $7 |
| Claude classify + prompts (Haiku, cached) | $3 |
| Veo 3 visual clips (~500 × 8s @ $0.15/s) | $90 |
| 69labs image/video b-roll (~400 calls) | $25 |
| 69labs TTS (~2h narration) | $15 |
| Storage + encode (R2 + GPU minutes) | $20 |
| **Total** | **~$160 per 2-hour video** |
