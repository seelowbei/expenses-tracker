import type { LedgerDetail } from "../../../worker/src/contracts/ledger";
import { useQuery } from "@tanstack/react-query";
import { getLedgerEntry } from "../api";
import { formatMoney } from "./format";

export function EntryDetail({ id, account, onEdit }: { id: string; account: string; onEdit: (entry: LedgerDetail) => void }) {
  const detail = useQuery({ queryKey: ["ledger-detail", account, id], queryFn: ({ signal }) => getLedgerEntry(id, signal) });
  if (detail.isPending) return <p role="status" className="p-4 text-sm">Loading details…</p>;
  if (detail.isError) return (
    <div role="alert" className="p-4 text-sm">
      Couldn't load this entry. <button className="underline" onClick={() => void detail.refetch()}>Retry details</button>
    </div>
  );
  const e = detail.data;
  return (
    <div className="space-y-3 border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-700">
      <button className="min-h-11 rounded-md bg-teal-700 px-4 py-2 font-medium text-white hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700" onClick={() => onEdit(e)}>Edit / confirm entry</button>
      {e.reviewed_at && <p className="text-slate-600 dark:text-slate-400">Reviewed · {e.reviewed_at.slice(0, 10)}</p>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <dt>Date &amp; time</dt><dd className="text-right tabular-nums">{e.txn_date}{e.txn_time ? ` · ${e.txn_time}` : ""}</dd>
        <dt>Tax</dt><dd className="text-right tabular-nums">{e.tax_minor === null ? "Not recorded" : formatMoney(e.tax_minor, e.currency)}</dd>
        <dt>Payment</dt><dd className="text-right">{e.payment_method?.replaceAll("_", " ") ?? "Not recorded"}</dd>
      </dl>
      {!!e.line_items?.length && (
        <ul aria-label="Line items" className="space-y-1">
          {e.line_items.map((item, i) => <li key={i} className="flex flex-wrap justify-between gap-x-3"><span className="break-words">{item.description}</span><span className="ml-auto text-right tabular-nums">{formatMoney(item.amount_minor, e.currency)}</span></li>)}
        </ul>
      )}
      {e.notes && <p className="whitespace-pre-wrap break-words">{e.notes}</p>}
      {e.receipt_status === "needs_review" && (
        <p className="text-amber-800 dark:text-amber-300">Needs review. Check the extracted values against the original receipt.</p>
      )}
      {e.drive_link ? (
        <a href={e.drive_link} target="_blank" rel="noreferrer" className="text-teal-700 underline dark:text-teal-400">Open original in Drive</a>
      ) : <p className="text-slate-600 dark:text-slate-400">Original receipt link unavailable. Your ledger entry is retained.</p>}
    </div>
  );
}
