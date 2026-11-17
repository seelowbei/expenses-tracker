import { describe, expect, it } from "vitest";
import { clearSession, createAppQueryClient } from "../../web/src/query-client";
import { ApiError } from "../../web/src/api-error";

describe("account query cache", () => {
  it("does not restore the old account from an in-flight profile response", async () => {
    const client = createAppQueryClient();
    const account = { email: "alice@example.com" };
    client.setQueryData(["me"], account);
    let finish!: (value: typeof account) => void;
    const pending = client.fetchQuery({ queryKey: ["me"], queryFn: () => new Promise<typeof account>((resolve) => { finish = resolve; }) });
    clearSession(client);
    finish(account);
    await pending.catch(() => undefined);
    expect(client.getQueryData(["me"])).toBeNull();
    client.clear();
  });
  it("updates the existing profile query and removes all account data on sign-out", () => {
    const client = createAppQueryClient();
    client.setQueryData(["me"], { email: "alice@example.com" });
    client.setQueryData(["ledger", "alice@example.com"], { entries: ["private"] });
    const profile = client.getQueryCache().find({ queryKey: ["me"] });
    clearSession(client);
    expect(client.getQueryCache().find({ queryKey: ["me"] })).toBe(profile);
    expect(profile?.state.data).toBeNull();
    expect(client.getQueryData(["ledger", "alice@example.com"])).toBeUndefined();
    client.clear();
  });

  it("expires the profile on an authenticated query's 401", async () => {
    const client = createAppQueryClient();
    client.setQueryData(["me"], { email: "alice@example.com" });
    const profile = client.getQueryCache().find({ queryKey: ["me"] });
    await expect(client.fetchQuery({ queryKey: ["ledger", "alice@example.com"], queryFn: () => { throw new ApiError(401, "unauthenticated"); } })).rejects.toThrow();
    expect(profile?.state.data).toBeNull();
    expect(client.getQueryData(["ledger", "alice@example.com"])).toBeUndefined();
    client.clear();
  });
});
