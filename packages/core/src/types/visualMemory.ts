export type VisualMemoryKind = 'character' | 'environment' | 'palette' | 'style_token';

export interface VisualMemoryEntry {
  id: string;
  projectId: string;
  kind: VisualMemoryKind;
  key: string;
  descriptor: string;
  referenceImageR2?: string;
  firstSeenShotId?: string;
  usageCount: number;
}
