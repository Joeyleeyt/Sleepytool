-- EmberForge one-shot bootstrap migration for Supabase Postgres.
-- Apply via `pnpm db:migrate` against the DIRECT connection (port 5432).
-- The transaction pooler (6543) rejects multi-statement DDL.
-- For ongoing schema changes, prefer `pnpm db:generate` + `pnpm db:migrate`.

-- Supabase already ships pgcrypto in the `extensions` schema. We CREATE here
-- only as a safety net for self-hosted Postgres; on Supabase this is a no-op.
-- The default search_path on Supabase already covers `extensions`, so
-- `gen_random_uuid()` resolves whichever schema actually holds pgcrypto.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================== ENUMS =====================================
DO $$ BEGIN
  CREATE TYPE project_status AS ENUM (
    'ingested','analyzed','segmented','classified','prompted',
    'generating_assets','assets_ready','timeline_built',
    'audio_mixed','composited','encoded','published','failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE visual_type AS ENUM (
    'cinematic_video','image_with_motion','infographic',
    'motion_typography','animated_diagram','atmospheric_broll'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE asset_kind AS ENUM (
    'video_clip','image','audio_narration','audio_music',
    'audio_sfx','subtitle_vtt','overlay_fx','final_render'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE gen_status AS ENUM ('queued','running','succeeded','failed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================== TABLES ====================================

CREATE TABLE IF NOT EXISTS projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL,
  title         TEXT NOT NULL,
  status        project_status NOT NULL DEFAULT 'ingested',
  style_preset  TEXT NOT NULL DEFAULT 'cinematic_dark_ember',
  target_res    TEXT NOT NULL DEFAULT '3840x2160',
  target_fps    INTEGER NOT NULL DEFAULT 30,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transcripts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  raw_text        TEXT NOT NULL,
  word_count      INTEGER,
  est_duration_s  INTEGER,
  analysis_json   JSONB,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scenes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ordinal           INTEGER NOT NULL,
  title             TEXT,
  narration_chunk   TEXT NOT NULL,
  emotion           TEXT,
  pacing            TEXT,
  atmosphere        TEXT,
  topic             TEXT,
  analysis          JSONB,
  start_word_idx    INTEGER,
  end_word_idx      INTEGER,
  estimated_dur_s   NUMERIC(6,2)
);
CREATE UNIQUE INDEX IF NOT EXISTS scenes_project_ordinal_uq ON scenes(project_id, ordinal);

CREATE TABLE IF NOT EXISTS shots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id          UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ordinal           INTEGER NOT NULL,
  narration_text    TEXT NOT NULL,
  duration_s        NUMERIC(5,2) NOT NULL,
  visual_type       visual_type NOT NULL,
  visual_summary    TEXT,
  camera_movement   TEXT,
  lens              TEXT,
  fx_recommendation JSONB,
  transition_in     TEXT,
  transition_out    TEXT,
  soundtrack_mood   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS shots_scene_ordinal_uq ON shots(scene_id, ordinal);

CREATE TABLE IF NOT EXISTS prompts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shot_id      UUID NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  target       TEXT NOT NULL,
  prompt_text  TEXT NOT NULL,
  negative     TEXT,
  seed         BIGINT,
  params       JSONB,
  input_hash   TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS prompts_shot_target_hash_uq
  ON prompts(shot_id, target, input_hash);

CREATE TABLE IF NOT EXISTS generations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id       UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  provider_job_id TEXT,
  status          gen_status NOT NULL DEFAULT 'queued',
  attempt         INTEGER NOT NULL DEFAULT 1,
  cost_usd        NUMERIC(8,4),
  latency_ms      INTEGER,
  error           JSONB,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_id       UUID REFERENCES shots(id) ON DELETE SET NULL,
  generation_id UUID REFERENCES generations(id),
  kind          asset_kind NOT NULL,
  r2_key        TEXT NOT NULL,
  bytes         BIGINT,
  duration_s    NUMERIC(8,3),
  width         INTEGER,
  height        INTEGER,
  metadata      JSONB,
  checksum      TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_project_kind_idx ON assets(project_id, kind);

CREATE TABLE IF NOT EXISTS timelines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  edl_json    JSONB NOT NULL,
  total_dur_s NUMERIC(8,2) NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS timelines_project_uq ON timelines(project_id);

CREATE TABLE IF NOT EXISTS renders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  timeline_id  UUID NOT NULL REFERENCES timelines(id),
  status       gen_status NOT NULL DEFAULT 'queued',
  r2_key       TEXT,
  duration_s   NUMERIC(8,2),
  bitrate_kbps INTEGER,
  cost_usd     NUMERIC(8,4),
  log          TEXT,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  queue       TEXT NOT NULL,
  bull_id     TEXT NOT NULL,
  state       TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  input_hash  TEXT NOT NULL,
  payload     JSONB,
  result      JSONB,
  error       JSONB,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs(state);
CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs(project_id);

CREATE TABLE IF NOT EXISTS retries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt    INTEGER NOT NULL,
  error      JSONB,
  next_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visual_memory (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  key                 TEXT NOT NULL,
  descriptor          TEXT NOT NULL,
  reference_image_r2  TEXT,
  first_seen_shot     UUID REFERENCES shots(id),
  usage_count         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS vm_proj_kind_key_uq
  ON visual_memory(project_id, kind, key);
CREATE INDEX IF NOT EXISTS vm_proj_kind_idx ON visual_memory(project_id, kind);

CREATE TABLE IF NOT EXISTS project_events (
  id         BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage      TEXT NOT NULL,
  event      TEXT NOT NULL,
  payload    JSONB,
  ts         TIMESTAMPTZ DEFAULT now()
);
