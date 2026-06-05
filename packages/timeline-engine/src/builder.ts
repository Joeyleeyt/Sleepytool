import { randomUUID } from 'node:crypto';
import { assetsRepo, shotsRepo } from '@emberforge/db';
import type { MusicBed, Shot, Timeline, TimelineClip } from '@emberforge/core';

export async function buildTimeline(projectId: string): Promise<Timeline> {
  const shots = await shotsRepo.findByProject(projectId);
  const assets = await assetsRepo.findByProject(projectId);
  const assetsByShot = new Map<string, typeof assets>();
  for (const a of assets) {
    if (!a.shotId) continue;
    const arr = assetsByShot.get(a.shotId) ?? [];
    arr.push(a);
    assetsByShot.set(a.shotId, arr);
  }

  let cursor = 0;
  const clips: TimelineClip[] = [];
  let subtitleIdx = 0;

  // One narrated clip per shot, laid out back-to-back in shot-plan order. No
  // freeze-still pacing: every shot becomes a single clip, in the exact order
  // shotsRepo.findByProject returns (scene.ordinal, then shot.ordinal).
  for (const shot of shots) {
    const shotAssets = assetsByShot.get(shot.id) ?? [];
    const video = shotAssets.find((a) => a.kind === 'video_clip' || a.kind === 'image');
    const narration = shotAssets.find((a) => a.kind === 'audio_narration');
    if (!video) throw new Error(`shot ${shot.id} missing video asset`);
    if (!narration) throw new Error(`shot ${shot.id} missing narration asset`);

    const dur = narration.durationS != null ? Number(narration.durationS) : Number(shot.durationS);
    const clip: TimelineClip = {
      shotId: shot.id,
      kind: 'clip',
      startS: cursor,
      endS: cursor + dur,
      videoAssetId: video.id,
      narrationAssetId: narration.id,
      overlayAssetIds: [],
      subtitleSegmentIdx: subtitleIdx++,
      transitionIn: (shot.transitionIn ?? 'cut') as never,
      transitionOut: (shot.transitionOut ?? 'cut') as never,
    };
    clips.push(clip);
    cursor += dur;
  }

  const musicBeds = layoutMusic(shots as unknown as Shot[], clips);

  return {
    id: randomUUID(),
    projectId,
    clips,
    totalDurationS: cursor,
    musicBeds,
    version: 1,
  };
}

function layoutMusic(shots: Shot[], clips: TimelineClip[]): MusicBed[] {
  if (clips.length === 0) return [];
  const beds: MusicBed[] = [];
  let bedStartIdx = 0;
  let currentMood = shots[0]?.soundtrackMood ?? 'ambient';

  for (let i = 1; i <= shots.length; i++) {
    const nextMood = i < shots.length ? shots[i]!.soundtrackMood : null;
    if (nextMood !== currentMood || i === shots.length) {
      beds.push({
        startS: clips[bedStartIdx]!.startS,
        endS: clips[i - 1]!.endS,
        assetId: pickMusicAssetIdForMood(currentMood),
        gainDb: currentMood === 'silence' ? -90 : -18,
      });
      bedStartIdx = i;
      if (nextMood) currentMood = nextMood;
    }
  }
  return beds;
}

// Placeholder: real implementation looks up a curated music library by mood.
function pickMusicAssetIdForMood(mood: string): string {
  return `music:${mood}`;
}
