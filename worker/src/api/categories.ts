import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env";
import { categoriesFor, createCategory } from "../db/categories";
import { CATEGORY_NAME_MAX, type CategoryDto } from "../contracts/categories";
import { readJsonBody } from "./json-body";

export const categoryRoutes = new Hono<AppEnv>();

categoryRoutes.get("/", async (c) => {
  const rows = await categoriesFor(c.var.db, c.var.user.id);
  const categories: CategoryDto[] = rows
    .map(({ id, slug, name }) => ({ id, slug, name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return c.json({ categories });
});

const CategoryCreate = z.strictObject({
  name: z.string().trim().min(1).max(CATEGORY_NAME_MAX).regex(/^[^\p{Cc}]+$/u),
});

categoryRoutes.post("/", async (c) => {
  const read = await readJsonBody(c.req.raw);
  if (!read.ok) return c.json({ error: read.error }, read.status);
  const parsed = CategoryCreate.safeParse(read.body);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    return c.json({ error: "invalid_body", fields }, 400);
  }
  const category = await createCategory(c.var.db, c.var.user.id, parsed.data.name);
  if (!category) return c.json({ error: "category_exists" }, 409);
  return c.json({ category }, 201);
});
