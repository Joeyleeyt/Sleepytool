import type { AssetKind } from '../enums.js';

export interface Asset {
  id: string;
  projectId: string;
  shotId: string | null;
  generationId: string | null;
  kind: AssetKind;
  r2Key: string;
  bytes: number | null;
  durationS: number | null;
  width: number | null;
  height: number | null;
  metadata: Record<string, unknown> | null;
  checksum: string | null;
  createdAt: Date;
}
