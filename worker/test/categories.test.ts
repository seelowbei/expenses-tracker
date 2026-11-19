import { describe, expect, it } from "vitest";
import { categories } from "../src/db/schema";
import { db, makeApp, ORIGIN, seedUser } from "./helpers";

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

const post = (cookie: string, body: unknown, origin = ORIGIN) => makeApp().request("/api/categories", {
  method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /api/categories", () => {
  it("requires a session and Origin and validates the body", async () => {
    const user = await seedUser();
    expect((await post("", { name: "Gifts" })).status).toBe(401);
    expect((await post(user.cookie, { name: "Gifts" }, "https://example.org")).status).toBe(403);
    for (const body of [{ name: " " }, { name: "x".repeat(61) }, { name: "A\nB" }, { name: "Gifts", userId: user.id }]) {
      const res = await post(user.cookie, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_body" });
    }
    expect((await post(user.cookie, { name: "x".repeat(33_000) })).status).toBe(413);
  });

  it("creates a private category and permits another owner to use the same name", async () => {
    const a = await seedUser();
    const b = await seedUser({ email: "bob@example.com" });
    const res = await post(a.cookie, { name: "  Café Supplies  " });
    expect(res.status).toBe(201);
    const { category } = await res.json<{ category: { id: string; name: string; slug: string } }>();
    expect(category).toEqual({ id: expect.any(String), name: "Café Supplies", slug: "cafe-supplies" });
    const list = async (cookie: string) =>
      (await makeApp().request("/api/categories", { headers: { Cookie: cookie } })).json<{ categories: unknown[] }>();
    expect((await list(a.cookie)).categories).toContainEqual(category);
    expect((await list(b.cookie)).categories).not.toContainEqual(category);
    expect((await post(b.cookie, { name: "Café Supplies" })).status).toBe(201);
  });

  it("rejects visible name and slug collisions, including concurrent requests", async () => {
    const user = await seedUser();
    await db().insert(categories).values({ id: crypto.randomUUID(), userId: user.id, name: "Legacy Name", slug: "legacy" });
    for (const name of ["legacy name", "FOOD & DINING", "Food Dining"]) {
      const res = await post(user.cookie, { name });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "category_exists" });
    }
    const results = await Promise.all([post(user.cookie, { name: "Gifts" }), post(user.cookie, { name: "gifts" })]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
  });

  it("gives Unicode-only names a stable ASCII slug", async () => {
    const user = await seedUser();
    const res = await post(user.cookie, { name: "お土産" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ category: { name: "お土産", slug: /^custom-[a-f0-9]{64}$/ } });
    expect((await post(user.cookie, { name: "お土産" })).status).toBe(409);
    expect((await post(user.cookie, { name: "旅行" })).status).toBe(201);
  });
});
