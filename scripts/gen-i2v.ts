/**
 * One-off image-to-video generation against 69labs.vip.
 *
 *   pnpm tsx scripts/gen-i2v.ts
 *
 * Submits a video job from an image URL + animation prompt, polls until
 * COMPLETED, resolves the download URL, and saves the mp4 locally.
 */
import { readFile, writeFile } from 'node:fs/promises';

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

const BASE = process.env.LABS69_BASE_URL ?? 'https://69labs.vip/api/v1';
const KEY = process.env.LABS69_API_KEY;
if (!KEY) {
  console.error('LABS69_API_KEY not set in .env');
  process.exit(2);
}
const auth = { Authorization: `Bearer ${KEY}` };

const IMAGE_URL =
  'https://cdn.discordapp.com/attachments/1505989294979022858/1518025626399801494/47F4A3B0-815F-4FD6-8D4D-E9150D58EF9E.jpg?ex=6a386b08&is=6a371988&hm=a23c3d0db66f1bc4dbad4cadaefa059b7d98ed21daf272045403deeef52a3004';

const PROMPT = [
  'Vertical short-form video, 9:16. The door that opens is the LEFT wall panel marked with the yellow "QUARANTINE — BREACH RISK" sign and yellow hazard tape — only that left hatch moves.',
  'Slow cinematic push-in through a dark industrial corridor toward the dented quarantine hatch on the left wall, 35mm lens, shallow handheld movement, growing tension.',
  'A low mechanical groan echoes through the corridor. One by one, massive steel bolts violently retract with metallic impacts. The final lock releases. The hatch jerks, then slowly slides open along rusted tracks.',
  'A violent burst of pressurized mist explodes from the gap. Dense fog pours across the floor. Dust and rust particles cascade from overhead pipes. The corridor lights dim momentarily before emergency red strips pulse back to life.',
  'As the opening widens, an abyss of complete darkness is revealed. The darkness appears unnaturally deep, swallowing surrounding light. Volumetric fog drifts from the doorway into the corridor.',
  'The camera continues pushing forward. In the background, the creature remains perfectly still — no breathing, no movement, only its silhouette intermittently illuminated by the flickering red lights. The right door with the cracked round window stays fully shut.',
  'Cinematic horror atmosphere, realistic industrial physics, drifting debris, atmospheric particles, subtle camera shake, strong depth, suspenseful pacing, photorealistic lighting.',
  'End frame: camera settles on the fully opened left hatch, darkness beyond impossible to see through, fog rolling outward while the silent creature watches from the shadows.',
].join(' ');

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

async function pollJob(statusPath: string): Promise<any> {
  const start = Date.now();
  const deadline = start + 10 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const s = (await api<any>(statusPath)) as any;
    if (s.status !== last) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`  [${elapsed}s] status → ${s.status}${s.queuePosition != null ? ` (queue ${s.queuePosition})` : ''}`);
      last = s.status;
    }
    if (s.status === 'COMPLETED') return s;
    if (s.status === 'FAILED' || s.status === 'CANCELLED' || s.status === 'CENSORED') {
      throw new Error(`status terminated: ${s.status} ${JSON.stringify(s)}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
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

const model = process.env.LABS69_VIDEO_MODEL && process.env.LABS69_VIDEO_MODEL.trim().length > 0
  ? process.env.LABS69_VIDEO_MODEL
  : undefined;

console.log('── Image-to-Video (69labs) ──');
console.log(`  model: ${model ?? '(default)'}`);
console.log(`  image: ${IMAGE_URL.slice(0, 80)}…`);
const t0 = Date.now();

const create = (await api<any>('/videos/generate', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt: PROMPT,
    model,
    aspectRatio: '9:16',
    imageUrls: [IMAGE_URL],
  }),
})) as any;

console.log(`  jobId: ${create.id}  queue: ${create.queuePosition ?? '?'}`);
const done = await pollJob(`/videos/status/${create.id}`);
const url = await resolveDownload(`/videos/download/${create.id}`);
console.log(`  ✓ done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  remote url: ${url.slice(0, 120)}…`);

const out = 'd:/tmp/quarantine-hatch-awakening-v4.mp4';
const bin = await fetch(url);
if (!bin.ok) throw new Error(`fetch mp4 ${bin.status}`);
const buf = Buffer.from(await bin.arrayBuffer());
await writeFile(out, buf);
console.log(`  saved: ${out} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  metadata: ${JSON.stringify(done.outputMetadata ?? {})}`);
