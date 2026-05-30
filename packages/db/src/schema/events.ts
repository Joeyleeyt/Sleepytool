apps/web dev: https://nextjs.org/docs/messages/module-not-found
apps/web dev: Import trace for requested module:
apps/web dev: ./src/app/api/v1/projects/route.ts
apps/web dev:  ⨯ ../../packages/core/src/schemas/index.ts:2:1
apps/web dev: Module not found: Can't resolve '../enums.js'
apps/web dev:   1 | import { z } from 'zod';
apps/web dev: > 2 | import { CAMERA_MOVES, EMOTIONS, LENS_PROFILES, PACING, STYLE_PRESETS, TRANSITIONS, VISUAL_TYPES } from '../enums.js';
apps/web dev:     | ^
apps/web dev:   3 |
apps/web dev:   4 | export const CreateProjectSchema = z.object({
apps/web dev:   5 |   title: z.string().min(1).max(200),
apps/web dev: https://nextjs.org/docs/messages/module-not-found
apps/web dev: Import trace for requested module:
apps/web dev: ./src/app/api/v1/projects/route.ts
apps/web dev:  GET /api/v1/projects 500 in 5834ms
apps/web dev:  GET / 500 in 42ms
apps/web dev: <w> [webpack.cache.PackFileCacheStrategy] Caching failed for pack: Error: ENOENT: no such file or directory, rename 'D:\Work\Joey\AI VIDEO\apps\web\.next\cache\webpack\client-development-fallback\0.pack.gz_' -> 'D:\Work\Joey\AI VIDEO\apps\web\.next\cache\webpack\client-development-fallback\0.pack.gz'
apps/web dev:  ⚠ Found a change in next.config.mjs. Restarting the server to apply the changes...
apps/web dev:   ▲ Next.js 14.2.35
apps/web dev:   - Local:        http://localhost:3000
apps/web dev:  ✓ Starting...
apps/web dev:  ✓ Ready in 6.3s
apps/web dev:  ○ Compiling / ...
apps/web dev:  ✓ Compiled / in 5.5s (651 modules)
apps/web dev:  ⚠ Fast Refresh had to perform a full reload due to a runtime error.
apps/web dev:  GET / 200 in 5633ms
apps/web dev:  GET /_next/static/webpack/5d6297b73689b32b.webpack.hot-update.json 404 in 5679ms
apps/web dev:  GET / 200 in 40ms
apps/web dev:  ○ Compiling /api/v1/projects ...
apps/web dev:  ✓ Compiled /api/v1/projects in 2.8s (825 modules)
apps/web dev: (node:5788) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.
apps/web dev: (Use `node --trace-deprecation ...` to show where the warning was created)
apps/web dev:  ⨯ ..\packages\db\src\client.ts (6:30) @ eval
apps/web dev:  ⨯ Error: DATABASE_URL not set
apps/web dev:     at eval (webpack-internal:///(rsc)/../../packages/db/src/client.ts:16:30) {
apps/web dev:   page: '/api/v1/projects'
apps/web dev: }
apps/web dev:   4 |
apps/web dev:   5 | const connectionString = process.env.DATABASE_URL;
apps/web dev: > 6 | if (!connectionString) throw new Error('DATABASE_URL not set');
apps/web dev:     |                              ^
apps/web dev:   7 |
apps/web dev:   8 | // Pool sized for Supabase's PgBouncer transaction pooler. We run 7 long-lived
apps/web dev:   9 | // processes (api + orchestrator + 4 workers + web SSR), each with its own
apps/web dev:  ○ Compiling /_error ...
apps/web dev:  ✓ Compiled /_error in 976ms (1384 modules)
apps/web dev:  GET /api/v1/projects 500 in 7938ms
apps/web dev:  ⨯ ..\packages\db\src\client.ts (6:30) @ eval
apps/web dev:  ⨯ Error: DATABASE_URL not set
apps/web dev:     at eval (webpack-internal:///(rsc)/../../packages/db/src/client.ts:16:30) {
apps/web dev:   page: '/api/v1/projects'
apps/web dev: }
apps/web dev:   4 |
apps/web dev:   5 | const connectionString = process.env.DATABASE_URL;
apps/web dev: > 6 | if (!connectionString) throw new Error('DATABASE_URL not set');
apps/web dev:     |                              ^
apps/web dev:   7 |
apps/web dev:   8 | // Pool sized for Supabase's PgBouncer transaction pooler. We run 7 long-lived
apps/web dev:   9 | // processes (api + orchestrator + 4 workers + web SSR), each with its own
apps/web dev:  GET /api/v1/projects 500 in 127ms
apps/web dev:  GET / 200 in 96ms
apps/web dev:  ⨯ ..\packages\db\src\client.ts (6:30) @ eval
apps/web dev:  ⨯ Error: DATABASE_URL not set
apps/web dev:     at eval (webpack-internal:///(rsc)/../../packages/db/src/client.ts:16:30) {
apps/web dev:   page: '/api/v1/projects'
apps/web dev: }
apps/web dev:   4 |
apps/web dev:   5 | const connectionString = process.env.DATABASE_URL;
apps/web dev: > 6 | if (!connectionString) throw new Error('DATABASE_URL not set');
apps/web dev:     |                              ^
apps/web dev:   7 |
apps/web dev:   8 | // Pool sized for Supabase's PgBouncer transaction pooler. We run 7 long-lived
apps/web dev:   9 | // processes (api + orchestrator + 4 workers + web SSR), each with its own
apps/web dev:  GET /api/v1/projects 500 in 17ms
apps/web dev:  ⨯ ..\packages\db\src\client.ts (6:30) @ eval
apps/web dev:  ⨯ Error: DATABASE_URL not set
apps/web dev:     at eval (webpack-internal:///(rsc)/../../packages/db/src/client.ts:16:30) {
apps/web dev:   page: '/api/v1/projects'
apps/web dev: }
apps/web dev:   4 |
apps/web dev:   5 | const connectionString = process.env.DATABASE_URL;
apps/web dev: > 6 | if (!connectionString) throw new Error('DATABASE_URL not set');
apps/web dev:     |                              ^
apps/web dev:   7 |
apps/web dev:   8 | // Pool sized for Supabase's PgBouncer transaction pooler. We run 7 long-lived
apps/web dev:   9 | // processes (api + orchestrator + 4 workers + web SSR), each with its own
apps/web dev:  GET /api/v1/projects 500 in 11ms
apps/web dev:  ⨯ ..\packages\db\src\client.ts (6:30) @ eval
apps/web dev:  ⨯ Error: DATABASE_URL not set
apps/web dev:     at eval (webpack-internal:///(rsc)/../../packages/db/src/client.ts:16:30) {
apps/web dev:   page: '/api/v1/projects'
apps/web dev: }
apps/web dev:   4 |
apps/web dev:   5 | const connectionString = process.env.DATABASE_URL;
apps/web dev: > 6 | if (!connectionString) throw new Error('DATABASE_URL not set');
apps/web dev:     |                              ^
apps/web dev:   7 |
apps/web dev:   8 | // Pool sized for Supabase's PgBouncer transaction pooler. We run 7 long-lived
apps/web dev:   9 | // processes (api + orchestrator + 4 workers + web SSR), each with its own
apps/web dev:  GET /api/v1/projects 500 in 14ms
apps/web dev:  ⨯ ..\packages\db\src\client.ts (6:30) @ eval
apps/web dev:  ⨯ Error: DATABASE_URL not set
apps/web dev:     at eval (webpack-internal:///(rsc)/../../packages/db/src/client.ts:16:30) {
apps/web dev:   page: '/api/v1/projects'
apps/web dev: }
apps/web dev:   4 |
apps/web dev:   5 | const connectionString = process.env.DATABASE_URL;
apps/web dev: > 6 | if (!connectionString) throw new Error('DATABASE_URL not set');
apps/web dev:     |                              ^
apps/web dev:   7 |
apps/web dev:   8 | // Pool sized for Supabase's PgBouncer transaction pooler. We run 7 long-lived
apps/web dev:   9 | // processes (api + orchestrator + 4 workers + web SSR), each with its own
apps/web dev:  GET /api/v1/projects 500 in 13msimport { bigserial, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';

export const projectEvents = pgTable('project_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),
  event: text('event').notNull(),
  payload: jsonb('payload'),
  ts: timestamp('ts', { withTimezone: true }).defaultNow(),
});
