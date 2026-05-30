import { NextResponse } from 'next/server';
import { assetsRepo, scenesRepo, shotsRepo } from '@emberforge/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { id } = params;
  const [scenes, shots, assets] = await Promise.all([
    scenesRepo.findByProject(id),
    shotsRepo.findByProject(id),
    assetsRepo.findByProject(id),
  ]);

  const assetsByShot = new Map<string, typeof assets>();
  for (const a of assets) {
    if (!a.shotId) continue;
    const arr = assetsByShot.get(a.shotId) ?? [];
    arr.push(a);
    assetsByShot.set(a.shotId, arr);
  }

  const shotsByScene = new Map<string, typeof shots>();
  for (const s of shots) {
    const arr = shotsByScene.get(s.sceneId) ?? [];
    arr.push(s);
    shotsByScene.set(s.sceneId, arr);
  }

  return NextResponse.json({
    scenes: scenes.map((scene) => ({
      ...scene,
      shots: (shotsByScene.get(scene.id) ?? []).map((shot) => {
        const a = assetsByShot.get(shot.id) ?? [];
        const visual = a.find((x) => x.kind === 'video_clip' || x.kind === 'image') ?? null;
        const narration = a.find((x) => x.kind === 'audio_narration') ?? null;
        return {
          ...shot,
          assets: {
            visual: visual
              ? { id: visual.id, kind: visual.kind, r2Key: visual.r2Key, durationS: visual.durationS }
              : null,
            narration: narration ? { id: narration.id, durationS: narration.durationS } : null,
          },
          status:
            visual && narration ? 'ready' : visual || narration ? 'partial' : 'pending',
        };
      }),
    })),
  });
}
