import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { categories } from "../db/schema";

/** System defaults and the user's own categories are visible; anything else is treated as missing. */
export async function categoryVisible(db: Db, userId: string, id: string): Promise<boolean> {
  const row = await db.select({ id: categories.id }).from(categories)
    .where(and(eq(categories.id, id), or(eq(categories.userId, userId), isNull(categories.userId)))).get();
  return row !== undefined;
}
