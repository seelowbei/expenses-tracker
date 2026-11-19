// Category lookups for the pipeline (and M4's categories API): the user's own plus the system defaults.
import { and, eq, isNull, notExists, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { categories, users, type Category } from "./schema";

const visibleTo = (userId: string) => or(eq(categories.userId, userId), isNull(categories.userId));

/** The user's custom categories and the system defaults (user_id NULL). Never another user's. */
export async function categoriesFor(db: Db, userId: string): Promise<Category[]> {
  return db
    .select()
    .from(categories)
    .where(visibleTo(userId));
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

export async function createCategory(db: Db, userId: string, name: string) {
  const id = crypto.randomUUID();
  let slug = name.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) {
    const bytes = new TextEncoder().encode(name.normalize("NFKC").toLowerCase());
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    slug = "custom-" + Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  const conflicts = db.select({ id: categories.id }).from(categories).where(and(
    visibleTo(userId),
    or(eq(categories.slug, slug), sql`lower(${categories.name}) = lower(${name})`),
  ));
  // A single statement checks visibility and inserts against the same database state.
  return db.insert(categories).select(db.select({
    id: sql<string>`${id}`.as("id"),
    userId: users.id,
    slug: sql<string>`${slug}`.as("slug"),
    name: sql<string>`${name}`.as("name"),
  }).from(users).where(and(eq(users.id, userId), notExists(conflicts))))
    .returning({ id: categories.id, slug: categories.slug, name: categories.name }).get();
}
