import type { ReceiptListItem, ReceiptPage, ReviewDetail } from "../../../worker/src/contracts/review";
import type { QueryClient } from "@tanstack/react-query";
import type { LedgerDetail } from "../../../worker/src/contracts/ledger";

const receiptQueryKeys = ["receipts", "ledger-detail", "review", "receipt-detail"];
const ledgerQueryKeys = ["ledger", ...receiptQueryKeys];

function markReceiptComplete(client: QueryClient, account: string, receiptId: string, entryId: string | null) {
  const state = { status: "done", error: null, retryAfter: null } as const;
  client.setQueryData<ReceiptListItem[]>(["receipts", account], (rows) => rows?.map((row) => row.id === receiptId
    ? { ...row, ...state, hasLedgerEntry: entryId !== null } : row));
  client.setQueriesData<ReceiptPage>({ queryKey: ["review", account] }, (page) => page
    ? { ...page, receipts: page.receipts.filter(row => row.id !== receiptId) } : page);
  client.setQueryData<ReviewDetail>(["receipt-detail", account, receiptId], (detail) => detail
    ? { ...detail, entryId, draft: null, receipt: { ...detail.receipt, ...state } } : detail);
}

/** Publish the confirmed save before refetching; pre-save reads cannot restore an old badge. */
export async function syncReviewedEntry(client: QueryClient, account: string, entry: LedgerDetail): Promise<boolean> {
  await Promise.all(receiptQueryKeys.map((key) => client.cancelQueries({ queryKey: [key, account] })));
  if (client.getQueryData<{ email: string } | null>(["me"])?.email !== account) return false;
  client.setQueryData(["ledger-detail", account, entry.id], entry);
  if (entry.receipt_id && entry.receipt_status === "done") {
    markReceiptComplete(client, account, entry.receipt_id, entry.id);
  }
  for (const key of ledgerQueryKeys) void client.invalidateQueries({ queryKey: [key, account] });
  return true;
}

export async function syncRemovedEntry(client: QueryClient, account: string, entry: LedgerDetail, confirmed: boolean): Promise<boolean> {
  await Promise.all(ledgerQueryKeys.map((key) => client.cancelQueries({ queryKey: [key, account] })));
  if (client.getQueryData<{ email: string } | null>(["me"])?.email !== account) return false;
  client.removeQueries({ queryKey: ["ledger-detail", account, entry.id], exact: true });
  if (confirmed && entry.receipt_id) {
    markReceiptComplete(client, account, entry.receipt_id, null);
  }
  for (const key of ledgerQueryKeys) void client.invalidateQueries({ queryKey: [key, account] });
  return true;
}
