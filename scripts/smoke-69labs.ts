/**
 * End-to-end smoke test against 69labs.vip.
 *
 * For each kind (TTS, image, video) it submits a job, polls until COMPLETED,
 * resolves the download URL, and reports timing + cost. Use this to confirm
 * the real API is reachable and the labs69 client wiring works.
 *
 *   pnpm tsx scripts/smoke-69labs.ts
 *   pnpm tsx scripts/smoke-69labs.ts --skip-video    # video costs more
 *   pnpm tsx scripts/smoke-69labs.ts --skip-image
 *   pnpm tsx scripts/smoke-69labs.ts --skip-tts
 */
import { readFile } from 'node:fs/promises';

async function loadDotEnv(path = '.env') {
  try {
    const txt = await readFile(path, 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      let value = t.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* .env missing is fine; we error below if vars aren't set */
  }
}
await loadDotEnv();

const args = new Set(process.argv.slice(2));
const SKIP_IMAGE = args.has('--skip-image');
const SKIP_VIDEO = args.has('--skip-video');
const SKIP_TTS = args.has('--skip-tts');

const BASE = process.env.LABS69_BASE_URL ?? 'https://69labs.vip/api/v1';
const KEY = process.env.LABS69_API_KEY;
const VOICE = process.env.LABS69_VOICE_ID;

if (!KEY) {
  console.error('LABS69_API_KEY not set in .env');
  process.exit(2);
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const auth = { Authorization: `Bearer ${KEY}` };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...auth },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

async function pollJob(statusPath: string, label: string): Promise<unknown> {
  const start = Date.now();
  const deadline = start + 5 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const s = (await api<{ status: string }>(statusPath)) as any;
    if (s.status !== last) {
      process.stdout.write(`  ${label} → ${cyan(s.status)}${s.queuePosition != null ? ` (queue ${s.queuePosition})` : ''}\n`);
      last = s.status;
    }
    if (s.status === 'COMPLETED') {
      return s;
    }
    if (s.status === 'FAILED' || s.status === 'CANCELLED' || s.status === 'CENSORED') {
      throw new Error(`status terminated: ${s.status}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('poll timed out');
}

async function resolveDownload(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: auth, redirect: 'manual' });
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location) return location;
  if (res.ok && res.url) return res.url;
  throw new Error(`download ${path} ${res.status}`);
}

async function runTts() {
  console.log(cyan('\n── TTS ──'));
  if (!VOICE) console.log(yellow('  no LABS69_VOICE_ID — using a default voice may fail'));
  const t0 = Date.now();
  const create = (await api<{ id: string; queuePosition?: number }>('/tts/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'EmberForge smoke test. This audio is generated only to verify the wiring.',
      voiceId: VOICE ?? '21m00Tcm4TlvDq8ikWAM',
      voiceProvider: 'elevenlabs',
    }),
  })) as any;
  console.log(`  jobId: ${create.id}  queue: ${create.queuePosition ?? '?'}`);
  await pollJob(`/tts/status/${create.id}`, 'tts');
  const url = await resolveDownload(`/tts/download/${create.id}`);
  console.log(green(`  ✓ TTS ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`));
  console.log(dim(`  url: ${url.slice(0, 100)}…`));
}

async function runImage() {
  console.log(cyan('\n── Image ──'));
  const t0 = Date.now();
  const create = (await api<{ id: string; queuePosition?: number }>('/images/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'cinematic ember-lit cathedral, 35mm anamorphic', aspectRatio: '16:9' }),
  })) as any;
  console.log(`  jobId: ${create.id}  queue: ${create.queuePosition ?? '?'}`);
  await pollJob(`/images/status/${create.id}`, 'image');
  const url = await resolveDownload(`/images/download/${create.id}`);
  console.log(green(`  ✓ Image ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`));
  console.log(dim(`  url: ${url.slice(0, 100)}…`));
}

async function runVideo() {
  console.log(cyan('\n── Video ──'));
  const t0 = Date.now();
  const create = (await api<{ id: string; queuePosition?: number }>('/videos/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'slow drift through foggy forest, golden hour', duration: '5', aspectRatio: '16:9' }),
  })) as any;
  console.log(`  jobId: ${create.id}  queue: ${create.queuePosition ?? '?'}`);
  await pollJob(`/videos/status/${create.id}`, 'video');
  const url = await resolveDownload(`/videos/download/${create.id}`);
  console.log(green(`  ✓ Video ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`));
  console.log(dim(`  url: ${url.slice(0, 100)}…`));
}

let exitCode = 0;
try {
  if (!SKIP_TTS) await runTts();
} catch (e) {
  exitCode = 1;
  console.log(red(`  ✗ TTS failed: ${(e as Error).message}`));
}
try {
  if (!SKIP_IMAGE) await runImage();
} catch (e) {
  exitCode = 1;
  console.log(red(`  ✗ Image failed: ${(e as Error).message}`));
}
try {
  if (!SKIP_VIDEO) await runVideo();
} catch (e) {
  exitCode = 1;
  console.log(red(`  ✗ Video failed: ${(e as Error).message}`));
}

console.log('');
if (exitCode === 0) console.log(green('All smoke tests passed.'));
else console.log(red('Some smoke tests failed — see above.'));
process.exit(exitCode);
