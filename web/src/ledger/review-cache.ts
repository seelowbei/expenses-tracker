import type { QueryClient } from "@tanstack/react-query";
import type { LedgerDetail } from "../../../worker/src/contracts/ledger";
type CachedReceipt = { id: string; status: string; error: string | null; retryAfter: string | null };

/** Publish the confirmed save before refetching; pre-save reads cannot restore an old badge. */
export async function syncReviewedEntry(client: QueryClient, account: string, entry: LedgerDetail): Promise<boolean> {
  await Promise.all(["receipts", "ledger-detail"].map((key) => client.cancelQueries({ queryKey: [key, account] })));
  if (client.getQueryData<{ email: string } | null>(["me"])?.email !== account) return false;
  client.setQueryData(["ledger-detail", account, entry.id], entry);
  if (entry.receipt_id && entry.receipt_status === "done") {
    client.setQueryData<CachedReceipt[]>(["receipts", account], (rows) => rows?.map((row) => row.id === entry.receipt_id
      ? { ...row, status: "done", error: null, retryAfter: null } : row));
  }
  for (const key of ["ledger", "ledger-detail", "receipts", "receipt-detail", "review"]) void client.invalidateQueries({ queryKey: [key, account] });
  return true;
}
