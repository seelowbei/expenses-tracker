import { describe, expect, it } from "vitest";
import { createAppQueryClient, clearSession } from "../../web/src/query-client";
import { syncReviewedEntry } from "../../web/src/ledger/review-cache";
import type { LedgerDetail } from "../src/contracts/ledger";

const account = "alice@example.com";
const receipt = { id: "r", status: "needs_review", mimeType: "image/jpeg", sizeBytes: 10, driveLink: null,
  error: null, retryAfter: null, reviewReasons: ["total_mismatch"], createdAt: "2026-11-17T00:00:00.000Z" };
type Receipt = typeof receipt;
const entry: LedgerDetail = { id: "e", receipt_id: "r", receipt_status: "done", category_id: "sys_other", category_name: "Other",
  merchant: "Synthetic", txn_date: "2026-11-17", txn_time: null, currency: "SGD", total_minor: 100,
  drive_link: null, tax_minor: null, payment_method: null, line_items: null, notes: null, source: "ai",
  confidence: 1, created_at: receipt.createdAt, updated_at: receipt.createdAt, reviewed_at: receipt.createdAt, review_reasons: receipt.reviewReasons };

describe("confirmed review cache update", () => {
  it("updates the matching recent receipt immediately, preserves warnings, and isolates accounts", async () => {
    const client = createAppQueryClient();
    client.setQueryData(["me"], { email: account });
    client.setQueryData(["receipts", account], [receipt, { ...receipt, id: "other" }]);
    client.setQueryData(["receipts", "bob@example.com"], [receipt]);
    expect(await syncReviewedEntry(client, account, entry)).toBe(true);
    expect(client.getQueryData(["receipts", account])).toEqual([{ ...receipt, status: "done" }, { ...receipt, id: "other" }]);
    expect(client.getQueryData(["receipts", "bob@example.com"])).toEqual([receipt]);
    expect(client.getQueryData(["ledger-detail", account, "e"])).toEqual(entry);
    client.clear();
  });
  it("cancels a pre-save response so it cannot restore the needs-review badge", async () => {
    const client = createAppQueryClient();
    client.setQueryData(["me"], { email: account });
    client.setQueryData(["receipts", account], [receipt]);
    let finish!: (data: Receipt[]) => void;
    const pending = client.fetchQuery({ queryKey: ["receipts", account], queryFn: () => new Promise<Receipt[]>((resolve) => { finish = resolve; }) });
    await syncReviewedEntry(client, account, entry);
    finish([receipt]); await pending.catch(() => undefined);
    expect(client.getQueryData(["receipts", account])).toEqual([{ ...receipt, status: "done" }]);
    client.clear();
  });
  it("does not recreate private data after sign-out", async () => {
    const client = createAppQueryClient();
    client.setQueryData(["me"], { email: account });
    clearSession(client);
    expect(await syncReviewedEntry(client, account, entry)).toBe(false);
    expect(client.getQueryData(["ledger-detail", account, "e"])).toBeUndefined();
    client.clear();
  });
});
