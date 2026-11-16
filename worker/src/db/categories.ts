// Category lookups for the pipeline (and M4's categories API): the user's own plus the system defaults.
import { eq, isNull, or } from "drizzle-orm";
import type { Db } from "./client";
import { categories, type Category } from "./schema";

/** The user's custom categories and the system defaults (user_id NULL). Never another user's. */
export async function categoriesFor(db: Db, userId: string): Promise<Category[]> {
  return db
    .select()
    .from(categories)
    .where(or(eq(categories.userId, userId), isNull(categories.userId)));
}

/** Unique slugs offered to the model. */
export function categorySlugs(list: readonly Category[]): string[] {
  return [...new Set(list.map((c) => c.slug))];
}

/** A user's own category wins over the system one with the same slug. */
export function categoryIdFor(list: readonly Category[], slug: string): string | null {
  const matches = list.filter((c) => c.slug === slug);
  return (matches.find((c) => c.userId !== null) ?? matches[0])?.id ?? null;
}
