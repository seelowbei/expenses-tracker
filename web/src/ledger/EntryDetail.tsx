import type { LedgerDetail } from "../../../worker/src/contracts/ledger";
import { useQuery } from "@tanstack/react-query";
import { getLedgerEntry } from "../api";
import { formatMoney } from "./format";
import { EditIcon, ExternalIcon } from "./icons";

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
    <div className="space-y-3 py-3 pr-4 pl-15 text-sm">
      {e.reviewed_at && <p className="muted text-xs">Reviewed · {e.reviewed_at.slice(0, 10)}</p>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        <dt className="muted">Date &amp; time</dt><dd className="text-right tabular-nums">{e.txn_date}{e.txn_time ? ` · ${e.txn_time}` : ""}</dd>
        <dt className="muted">Tax</dt><dd className="text-right tabular-nums">{e.tax_minor === null ? "Not recorded" : formatMoney(e.tax_minor, e.currency)}</dd>
        <dt className="muted">Payment</dt><dd className="text-right">{e.payment_method?.replaceAll("_", " ") ?? "Not recorded"}</dd>
      </dl>
      {!!e.line_items?.length && (
        <ul aria-label="Line items" className="space-y-1 border-t border-slate-200 pt-2 dark:border-slate-700">
          {e.line_items.map((item, i) => <li key={i} className="flex flex-wrap justify-between gap-x-3"><span className="muted break-words">{item.description}</span><span className="ml-auto text-right tabular-nums">{formatMoney(item.amount_minor, e.currency)}</span></li>)}
        </ul>
      )}
      {e.notes && <p className="whitespace-pre-wrap break-words">{e.notes}</p>}
      {e.receipt_status === "needs_review" && (
        <p className="text-amber-800 dark:text-amber-300">Needs review. Check the extracted values against the original receipt.</p>
      )}
      <div className="flex items-center justify-between gap-3 pt-1">
        {e.drive_link
          ? <a href={e.drive_link} target="_blank" rel="noreferrer" className="btn btn-drive"><ExternalIcon />View in Drive</a>
          : <p className="muted text-xs">Original receipt link unavailable. Your ledger entry is retained.</p>}
        <button className="btn btn-icon btn-edit shrink-0" aria-label="Edit entry" title="Edit entry" onClick={() => onEdit(e)}><EditIcon /></button>
      </div>
    </div>
  );
}
