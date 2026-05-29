/**
 * Print per-project asset stats — how many shots got their AI image / AI video
 * clip / narration, broken out by visualType and overall.
 *
 *   pnpm tsx scripts/project-stats.ts                  # latest project
 *   pnpm tsx scripts/project-stats.ts <projectId>
 */

const API = process.env.EMBERFORGE_API ?? 'http://localhost:8080';

interface ShotAssets {
  visual: { id: string; kind: string; r2Key: string } | null;
  narration: { id: string } | null;
}
interface Shot {
  id: string;
  ordinal: number;
  visualType: string;
  status: 'pending' | 'partial' | 'ready';
  assets: ShotAssets;
}
interface Scene { id: string; ordinal: number; shots: Shot[] }
interface ScenesResp { scenes: Scene[] }
interface Project { id: string; title: string; status: string; updatedAt: string }

const IMAGE_TYPES = new Set(['image_with_motion']);
const VIDEO_TYPES = new Set(['cinematic_video', 'atmospheric_broll', 'infographic', 'animated_diagram', 'motion_typography']);

async function pickProjectId(): Promise<string> {
  const arg = process.argv[2];
  if (arg) return arg;
  const res = await fetch(`${API}/v1/projects`);
  if (!res.ok) throw new Error(`listProjects ${res.status}`);
  const { projects } = (await res.json()) as { projects: Project[] };
  if (!projects.length) throw new Error('no projects yet — submit a transcript first');
  return projects[0]!.id;
}

const projectId = await pickProjectId();
const res = await fetch(`${API}/v1/projects/${projectId}/scenes`);
if (!res.ok) throw new Error(`getScenes ${res.status}: ${await res.text()}`);
const { scenes } = (await res.json()) as ScenesResp;
const shots: Shot[] = scenes.flatMap((s) => s.shots);

const buckets = {
  image: { total: 0, ready: 0 },
  video: { total: 0, ready: 0 },
  narration: { total: shots.length, ready: 0 },
};

for (const shot of shots) {
  if (IMAGE_TYPES.has(shot.visualType)) {
    buckets.image.total++;
    if (shot.assets.visual?.kind === 'image') buckets.image.ready++;
  } else if (VIDEO_TYPES.has(shot.visualType)) {
    buckets.video.total++;
    if (shot.assets.visual?.kind === 'video_clip') buckets.video.ready++;
  }
  if (shot.assets.narration) buckets.narration.ready++;
}

const pct = (r: number, t: number): string => (t === 0 ? 'n/a' : `${((r / t) * 100).toFixed(1)}%`);

console.log(`\nproject ${projectId}`);
console.log('─'.repeat(60));
console.log(`Shots total:       ${shots.length}`);
console.log(`  Video-type:      ${buckets.video.total}  (target: 80%)`);
console.log(`  Image-type:      ${buckets.image.total}  (target: 20%)`);
console.log('');
console.log('Generated assets');
console.log('─'.repeat(60));
console.log(`AI video clips:    ${buckets.video.ready}/${buckets.video.total}    ${pct(buckets.video.ready, buckets.video.total)}`);
console.log(`AI images:         ${buckets.image.ready}/${buckets.image.total}    ${pct(buckets.image.ready, buckets.image.total)}`);
console.log(`TTS narration:     ${buckets.narration.ready}/${buckets.narration.total}    ${pct(buckets.narration.ready, buckets.narration.total)}`);
console.log('');

const fullyReady = shots.filter((s) => s.status === 'ready').length;
console.log(`Fully ready shots: ${fullyReady}/${shots.length}    ${pct(fullyReady, shots.length)}`);
