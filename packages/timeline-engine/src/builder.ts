import { randomUUID } from 'node:crypto';
import { assetsRepo, shotsRepo } from '@emberforge/db';
import type { MusicBed, Shot, Timeline, TimelineClip } from '@emberforge/core';

// Pacing pattern (per-shot): which slots are narrated video Clips (C) and which
// are inserted silent freeze-frame Stills (S). A freeze freezes the last frame
// of the most recent Clip and holds it FREEZE_STILL_S seconds.
//   First PATTERN_SWITCH_S of timeline: C C S  → 2 clips, then 1 freeze still.
//   After that:                         C S S  → 1 clip, then 2 freeze stills.
const PATTERN_SWITCH_S = Number(process.env.PATTERN_SWITCH_S ?? 20 * 60); // 20 minutes
const FREEZE_MIN_S = Number(process.env.FREEZE_STILL_MIN_S ?? 3);
const FREEZE_MAX_S = Number(process.env.FREEZE_STILL_MAX_S ?? 4);
const PATTERN_EARLY: ('clip' | 'still')[] = ['clip', 'clip', 'still'];
const PATTERN_LATE: ('clip' | 'still')[] = ['clip', 'still', 'still'];

function freezeDurationS(): number {
  // Hold each still 3–4s (configurable). Randomized for a natural rhythm.
  return FREEZE_MIN_S + Math.random() * Math.max(0, FREEZE_MAX_S - FREEZE_MIN_S);
}

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
  // Narrated clips only — used for music bed layout (freeze stills are silent).
  const narratedClips: TimelineClip[] = [];
  // The last narrated clip placed, so a 'still' slot knows which frame to freeze.
  let lastClip: TimelineClip | null = null;
  let subtitleIdx = 0;
  let shotIdx = 0;

  // Walk the repeating template, consuming a shot for each 'clip' slot and
  // inserting a freeze still for each 'still' slot. The template is re-selected
  // at the start of every cycle based on the current timeline position, so the
  // C-C-S → C-S-S switch happens once we pass PATTERN_SWITCH_S.
  while (shotIdx < shots.length) {
    const pattern = cursor < PATTERN_SWITCH_S ? PATTERN_EARLY : PATTERN_LATE;
    for (const slot of pattern) {
      if (slot === 'clip') {
        if (shotIdx >= shots.length) break;
        const shot = shots[shotIdx]!;
        shotIdx += 1;
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
        narratedClips.push(clip);
        lastClip = clip;
        cursor += dur;
      } else {
        // 'still' — freeze the last narrated clip's final frame. Skip if no clip
        // has been placed yet (a still can't precede the first clip).
        if (!lastClip) continue;
        const dur = freezeDurationS();
        clips.push({
          shotId: lastClip.shotId,
          kind: 'freeze',
          startS: cursor,
          endS: cursor + dur,
          videoAssetId: lastClip.videoAssetId,
          overlayAssetIds: [],
          subtitleSegmentIdx: -1,
          transitionIn: 'cut' as never,
          transitionOut: 'cut' as never,
        });
        cursor += dur;
      }
    }
  }

  const musicBeds = layoutMusic(shots as unknown as Shot[], narratedClips);

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
