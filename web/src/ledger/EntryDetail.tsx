import { useQuery } from "@tanstack/react-query";
import { getLedgerEntry } from "../api";
import { formatMoney } from "./format";

export function EntryDetail({ id, account }: { id: string; account: string }) {
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
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <dt>Transaction date</dt><dd>{e.txn_date}</dd>
        <dt>Transaction time</dt><dd>{e.txn_time ?? "Not printed"}</dd>
        <dt>Tax</dt><dd>{e.tax_minor === null ? "Not recorded" : formatMoney(e.tax_minor, e.currency)}</dd>
        <dt>Payment</dt><dd>{e.payment_method?.replaceAll("_", " ") ?? "Not recorded"}</dd>
      </dl>
      {!!e.line_items?.length && (
        <ul aria-label="Line items" className="space-y-1">
          {e.line_items.map((item, i) => <li key={i} className="flex flex-wrap justify-between gap-x-3"><span className="break-words">{item.description}</span><span className="tabular-nums">{formatMoney(item.amount_minor, e.currency)}</span></li>)}
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
