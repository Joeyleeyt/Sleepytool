'use client';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ProgressBar } from '@/components/primitives/ProgressBar';
import { Badge } from '@/components/primitives/Badge';
import { STAGE_LABELS, TERMINAL_STATUSES } from '@/lib/utils';

const PIPELINE_STAGES = [
  'ingested', 'analyzed', 'segmented', 'classified', 'prompted',
  'generating_assets', 'assets_ready', 'timeline_built',
  'audio_mixed', 'composited', 'encoded', 'published',
];

export function StatusBar() {
  const params = useParams() as { projectId?: string };
  const projectId = params.projectId ?? '';

  const { data } = useQuery({
    queryKey: ['progress', projectId],
    queryFn: () => api.getProgress(projectId),
    enabled: !!projectId,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status && TERMINAL_STATUSES.has(status) ? false : 3000;
    },
  });

  if (!projectId || !data) return <div className="h-10 shrink-0 border-t border-border bg-bg-subtle" />;

  const stageIdx = PIPELINE_STAGES.indexOf(data.status);
  const overallPct = stageIdx >= 0 ? (stageIdx + 1) / PIPELINE_STAGES.length : 0;
  const shotsPct = data.shots.total > 0 ? data.shots.ready / data.shots.total : 0;
  const inAssetStage = data.status === 'generating_assets';
  const tone =
    data.status === 'published' ? 'ok' :
    data.status === 'failed' ? 'busy' : 'ember';

  return (
    <div className="h-10 shrink-0 flex items-center gap-4 px-4 border-t border-border bg-bg-subtle text-xs">
      <Badge
        tone={
          data.status === 'published' ? 'ok' :
          data.status === 'failed' ? 'bad' :
          data.status === 'ingested' ? 'neutral' : 'busy'
        }
      >
        {STAGE_LABELS[data.status] ?? data.status}
      </Badge>
      <div className="flex-1 max-w-xs">
        <ProgressBar value={inAssetStage ? shotsPct : overallPct} tone={tone === 'ok' ? 'ok' : tone === 'busy' ? 'busy' : 'ember'} />
      </div>
      <div className="text-text-dim tabular-nums">
        Assets {data.shots.ready}/{data.shots.total}
        {data.shots.failed > 0 && <span className="text-bad ml-2">⚠ {data.shots.failed} failed</span>}
      </div>
    </div>
  );
}
