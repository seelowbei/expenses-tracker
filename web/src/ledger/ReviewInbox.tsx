import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { LedgerDetail } from "../../../worker/src/contracts/ledger";
import type { ReviewDetail, ReviewDraft } from "../../../worker/src/contracts/review";
import { ApiError, getLedgerEntry, getReceiptDetail, listReviewReceipts } from "../api";
import { EntryEditor } from "./EntryEditor";
import { editorButton } from "./EntryFields";

type Selection = { entry: LedgerDetail } | { review: ReviewDetail & { draft: ReviewDraft } };
export function ReviewInbox({ account, revision, onSaved }: { account: string; revision: number; onSaved: () => void }) {
  const qc = useQueryClient();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [editing, setEditing] = useState<Selection | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const active = useRef(true);
  const cursor = cursors.at(-1);
  const page = useQuery({ queryKey: ["review", account, cursor], queryFn: ({ signal }) => listReviewReceipts(cursor, signal) });
  useEffect(() => { setCursors([undefined]); }, [revision]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const refresh = () => { setCursors([undefined]); void qc.invalidateQueries({ queryKey: ["review", account] }); };
  const open = async (id: string) => {
    setOpening(id); setOpenError(null); setNotice("");
    try {
      const detail = await qc.fetchQuery({ queryKey: ["receipt-detail", account, id], queryFn: ({ signal }) => getReceiptDetail(id, signal), staleTime: 0 });
      if (!active.current) return;
      if (detail.entryId) {
        const entry = await qc.fetchQuery({ queryKey: ["ledger-detail", account, detail.entryId], queryFn: ({ signal }) => getLedgerEntry(detail.entryId!, signal), staleTime: 0 });
        if (active.current) setEditing({ entry });
      } else if (detail.draft !== null) setEditing({ review: { ...detail, draft: detail.draft } });
      else { setNotice("This receipt is no longer awaiting review. The inbox has been refreshed."); refresh(); }
    } catch (e) {
      if (active.current && !(e instanceof ApiError && e.status === 401)) setOpenError(id);
    } finally { if (active.current) setOpening(null); }
  };
  return <section aria-labelledby="review-heading" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 id="review-heading" tabIndex={-1} className="text-lg font-semibold">Needs review</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">Pending receipts from every month and category.</p></div>
      <button className={editorButton} disabled={page.isFetching} onClick={refresh}>Refresh reviews</button>
    </div>
    {notice && <p role="status" className="text-sm text-teal-700 dark:text-teal-400">{notice}</p>}
    {editing && <EntryEditor {...editing} focusTargetId="review-heading" account={account} onClose={() => setEditing(null)}
      onSaved={() => { setEditing(null); setNotice("Review saved. Ledger totals updated."); onSaved(); }}
      onRemoved={(confirmed) => {
        setEditing(null); onSaved();
        setNotice(confirmed ? "Expense deleted. Ledger totals updated." : "This expense is no longer available.");
      }} />}
    {page.isPending ? <p role="status">Loading pending receipts…</p> : <>
      {page.isError && <p role="alert" className="text-sm">Couldn't load pending receipts. {page.data ? "Showing the last known list. " : ""}<button className="underline" onClick={() => void page.refetch()}>Retry reviews</button></p>}
      {page.data && (page.data.receipts.length ? <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {page.data.receipts.map(receipt => <li key={receipt.id} className="space-y-2 p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">Uploaded {new Date(receipt.createdAt).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" })}</p>
              <p className="text-slate-600 dark:text-slate-400">{receipt.error === "invalid_output" ? "Complete missing details" : "Check extracted details"} · {receipt.id.slice(-6)}</p>
              {receipt.driveLink && <a href={receipt.driveLink} target="_blank" rel="noreferrer" className="text-teal-700 underline dark:text-teal-400">Open original in Drive</a>}
            </div>
            <button className={editorButton} disabled={opening !== null} onClick={() => void open(receipt.id)} aria-label={`Review receipt ${receipt.id.slice(-6)}`}>{opening === receipt.id ? "Opening…" : "Review"}</button>
          </div>
          {openError === receipt.id && <p role="alert">Couldn't open this receipt. Your data is unchanged. <button className="underline" disabled={opening !== null} onClick={() => void open(receipt.id)}>Retry opening</button></p>}
        </li>)}
      </ul> : <p role="status" className="rounded-lg border border-dashed border-slate-300 p-4 text-sm dark:border-slate-700">{cursors.length === 1 ? "You're up to date. No receipts need review." : "No pending receipts remain on this page. Refresh reviews to return to the first page."}</p>)}
      {page.data && <nav aria-label="Review pages" className="flex items-center justify-between gap-2">
        <button className={editorButton} disabled={cursors.length === 1 || page.isFetching || opening !== null} onClick={() => setCursors(p => p.slice(0, -1))}>Previous reviews</button>
        <span role="status" className="text-sm">Page {cursors.length}{page.isFetching ? " · Updating…" : ""}</span>
        <button className={editorButton} disabled={!page.data.nextCursor || page.isFetching || opening !== null} onClick={() => setCursors(p => [...p, page.data.nextCursor!])}>Next reviews</button>
      </nav>}
    </>}
  </section>;
}
