import { NextResponse } from 'next/server';
import { eventsRepo, projectsRepo } from '@emberforge/db';
import { queues } from '@emberforge/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const STAGE_DISPATCH: Record<
  string,
  { queue: keyof typeof queues; name: string; buildData: (projectId: string) => Record<string, unknown> }
> = {
  analyze:        { queue: 'analysis',     name: 'analyze',        buildData: (p) => ({ projectId: p, stage: 'analyze' }) },
  segment:        { queue: 'analysis',     name: 'segment',        buildData: (p) => ({ projectId: p, stage: 'segment' }) },
  classify:       { queue: 'analysis',     name: 'classify',       buildData: (p) => ({ projectId: p, stage: 'classify' }) },
  prompt:         { queue: 'prompt',       name: 'prompt',         buildData: (p) => ({ projectId: p }) },
  generateAssets: { queue: 'orchestrator', name: 'generateAssets', buildData: (p) => ({ projectId: p, stage: 'generateAssets' }) },
  buildTimeline:  { queue: 'timeline',     name: 'buildTimeline',  buildData: (p) => ({ projectId: p }) },
  mixAudio:       { queue: 'audio',        name: 'mixAudio',       buildData: (p) => ({ projectId: p }) },
  composite:      { queue: 'render',       name: 'composite',      buildData: (p) => ({ projectId: p, stage: 'composite' }) },
  encode:         { queue: 'render',       name: 'encode',         buildData: (p) => ({ projectId: p, stage: 'encode' }) },
  publish:        { queue: 'publish',      name: 'publish',        buildData: (p) => ({ projectId: p }) },
};

export async function POST(
  _request: Request,
  { params }: { params: { id: string; stage: string } },
) {
  const { id, stage } = params;
  const dispatch = STAGE_DISPATCH[stage];
  if (!dispatch) {
    return NextResponse.json(
      { error: `unknown stage: ${stage}`, validStages: Object.keys(STAGE_DISPATCH) },
      { status: 400 },
    );
  }
  const project = await projectsRepo.findById(id);
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  const job = await queues[dispatch.queue].add(dispatch.name, dispatch.buildData(id));
  await eventsRepo.emit(id, stage, 'replay_enqueued', { jobId: job.id, queue: dispatch.queue });
  return NextResponse.json({
    ok: true,
    replay: { projectId: id, stage, jobId: job.id, queue: dispatch.queue },
  });
}
