import { Hono } from "hono";
import type { AppEnv } from "../app-env";
import { categoriesFor } from "../db/categories";

export interface CategoryDto {
  id: string;
  slug: string;
  name: string;
}

export const categoryRoutes = new Hono<AppEnv>();

categoryRoutes.get("/", async (c) => {
  const rows = await categoriesFor(c.var.db, c.var.user.id);
  const categories: CategoryDto[] = rows
    .map(({ id, slug, name }) => ({ id, slug, name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return c.json({ categories });
});
