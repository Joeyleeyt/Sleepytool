import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ASSET_KINDS,
  GEN_STATUSES,
  PROJECT_STATUSES,
  VISUAL_TYPES,
} from '@emberforge/core';

export const projectStatusEnum = pgEnum('project_status', PROJECT_STATUSES);
export const visualTypeEnum = pgEnum('visual_type', VISUAL_TYPES);
export const assetKindEnum = pgEnum('asset_kind', ASSET_KINDS);
export const genStatusEnum = pgEnum('gen_status', GEN_STATUSES);
