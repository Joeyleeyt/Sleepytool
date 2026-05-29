import { and, eq } from 'drizzle-orm';
import { db } from '../client.js';
import { prompts } from '../schema/index.js';

export const promptsRepo = {
  async upsert(row: typeof prompts.$inferInsert) {
    const [out] = await db
      .insert(prompts)
      .values(row)
      .onConflictDoUpdate({
        target: [prompts.shotId, prompts.target, prompts.inputHash],
        set: { promptText: row.promptText, params: row.params, negative: row.negative },
      })
      .returning();
    return out!;
  },

  async findForShot(shotId: string, target: string) {
    const [row] = await db
      .select()
      .from(prompts)
      .where(and(eq(prompts.shotId, shotId), eq(prompts.target, target)))
      .limit(1);
    return row ?? null;
  },
};
