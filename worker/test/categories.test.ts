import { describe, expect, it } from "vitest";
import { categories } from "../src/db/schema";
import { db, makeApp, seedUser } from "./helpers";

describe("GET /api/categories", () => {
  it("requires a session", async () => {
    expect((await makeApp().request("/api/categories")).status).toBe(401);
  });

  it("lists only defaults and the user's categories in stable name order", async () => {
    const a = await seedUser();
    const b = await seedUser({ email: "bob@example.com" });
    const ownId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    await db().insert(categories).values([
      { id: ownId, userId: a.id, name: "A custom category", slug: "food-dining" },
      { id: otherId, userId: b.id, name: "Private", slug: "private" },
    ]);
    const { request, fake } = makeApp();
    const res = await request("/api/categories", { headers: { Cookie: a.cookie } });
    expect(res.status).toBe(200);
    const body = await res.json() as { categories: { id: string; name: string; slug: string }[] };
    expect(body.categories[0]).toEqual({ id: ownId, name: "A custom category", slug: "food-dining" });
    expect(body.categories.some((c) => c.id.startsWith("sys_"))).toBe(true);
    expect(body.categories.some((c) => c.id === otherId)).toBe(false);
    expect(body.categories.every((c) => Object.keys(c).sort().join() === "id,name,slug")).toBe(true);
    expect(fake.calls).toEqual([]);
  });
});
