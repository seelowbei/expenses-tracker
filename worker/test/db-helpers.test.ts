import { describe, expect, it } from "vitest";
import type { AiCallRecord } from "../src/agent/usage";
import { categoriesFor, categoryIdFor, categorySlugs } from "../src/db/categories";
import { categories } from "../src/db/schema";
import { usageRows } from "../src/db/usage";
import { db, seedUser } from "./helpers";

describe("categories", () => {
  it("returns system defaults plus only the user's own categories", async () => {
    const alice = await seedUser();
    const bob = await seedUser({ email: "bob@example.com" });
    await db().insert(categories).values([
      { id: `a-pets-${alice.id}`, userId: alice.id, slug: "pets", name: "Pets" },
      { id: `b-golf-${bob.id}`, userId: bob.id, slug: "golf", name: "Golf" },
    ]);
    const slugs = categorySlugs(await categoriesFor(db(), alice.id));
    expect(slugs).toContain("food-dining");
    expect(slugs).toContain("pets");
    expect(slugs).not.toContain("golf");
    expect(slugs).toHaveLength(14);
  });

  it("prefers the user's own category over a system one with the same slug", () => {
    const list = [
      { id: "sys_travel", userId: null, slug: "travel", name: "Travel" },
      { id: "mine", userId: "u1", slug: "travel", name: "My travel" },
    ];
    expect(categoryIdFor(list, "travel")).toBe("mine");
    expect(categoryIdFor(list.slice(0, 1), "travel")).toBe("sys_travel");
    expect(categoryIdFor(list, "nope")).toBeNull();
    expect(categorySlugs(list)).toEqual(["travel"]);
  });
});

describe("usageRows", () => {
  it("maps each call record to one ai_usage row", () => {
    const rec: AiCallRecord = {
      kind: "extract", model: "m", inputMode: "image", promptTokens: 10, completionTokens: 2,
      neuronsEst: 0.5, latencyMs: 40, outcome: "ok", errorCode: null,
    };
    const rows = usageRows([rec, { ...rec, kind: "repair", outcome: "invalid_output", errorCode: "invalid_output" }], {
      userId: "u", receiptId: "r", attempt: 2, createdAt: "2026-11-11T00:00:00.000Z",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ userId: "u", receiptId: "r", attempt: 2, kind: "extract", promptTokens: 10, neuronsEst: 0.5 });
    expect(rows[1]).toMatchObject({ kind: "repair", outcome: "invalid_output", errorCode: "invalid_output" });
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });
});
