import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { LedgerDetail } from "../../../worker/src/contracts/ledger";
import { ApiError, getLedgerEntry, listCategories, patchLedgerEntry } from "../api";
import { clearSession } from "../query-client";
import { EntryFields, editorButton } from "./EntryFields";
import { entryForm, formPatch, type FormErrors } from "./form";
import { syncReviewedEntry } from "./review-cache";
import { formatMoney } from "./format";

export function EntryEditor({ entry, account, onClose, onSaved }: {
  entry: LedgerDetail; account: string; onClose: () => void; onSaved: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const [base, setBase] = useState(entry);
  const [form, setForm] = useState(() => entryForm(entry));
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);
  const [currencyConfirmed, setCurrencyConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [mustReload, setMustReload] = useState(false);
  const [latest, setLatest] = useState<LedgerDetail | null>(null);
  const categories = useQuery({ queryKey: ["categories", account], queryFn: ({ signal }) => listCategories(signal) });
  const dirty = JSON.stringify(form) !== JSON.stringify(entryForm(base));
  useEffect(() => {
    active.current = true;
    const opener = document.activeElement;
    dialog.current?.showModal();
    return () => {
      active.current = false; request.current?.abort();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      else document.getElementById("ledger-heading")?.focus();
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const close = () => { if (!busy && (!dirty || window.confirm("Discard your unsaved changes?"))) onClose(); };
  const reload = async () => {
    setBusy(true);
    request.current = new AbortController();
    try {
      const fresh = await getLedgerEntry(entry.id, request.current.signal);
      if (active.current) {
        setLatest(fresh);
        qc.setQueryData(["ledger-detail", account, entry.id], fresh);
        for (const key of ["ledger", "receipts"]) void qc.invalidateQueries({ queryKey: [key, account] });
      }
    } catch (e) {
      if (!active.current) return;
      if (e instanceof ApiError && e.status === 401) clearSession(qc);
      else setMessage("Couldn't reload this entry. Your draft is retained. Try loading it again.");
    } finally { if (active.current) setBusy(false); }
  };
  const save = async () => {
    const result = formPatch(form, base, currencyConfirmed);
    if (result.errors) { setErrors(result.errors); setMessage("Check the highlighted fields."); return; }
    setErrors({}); setMessage(""); setBusy(true);
    request.current = new AbortController();
    try {
      const saved = await patchLedgerEntry(entry.id, result.patch, request.current.signal);
      if (!active.current) return;
      if (await syncReviewedEntry(qc, account, saved) && active.current) onSaved();
    } catch (e) {
      if (!active.current) return;
      if (e instanceof ApiError && e.status === 401) { clearSession(qc); return; }
      const uncertain = !(e instanceof ApiError) || e.status >= 500 || e.status === 409;
      setMessage(e instanceof ApiError && e.code === "entry_changed" ? "This entry changed in another tab. Compare the latest saved values below; your draft is retained."
        : e instanceof ApiError && e.code === "receipt_busy" ? "This receipt is still processing. Your draft is retained. Load it again when processing finishes."
        : uncertain ? "Couldn't confirm the save. Your draft is retained. Check the latest saved values before trying again."
        : "Couldn't save this entry. Check the fields and try again. Your draft is retained.");
      if (uncertain) { setMustReload(true); await reload(); }
    } finally { if (active.current) setBusy(false); }
  };
  return <dialog ref={dialog} aria-labelledby="editor-title" onCancel={(e) => { e.preventDefault(); close(); }}
    className="fixed inset-0 m-auto max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 text-slate-900 shadow-lg backdrop:bg-slate-950/60 sm:p-6 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
    <form noValidate onSubmit={(e) => { e.preventDefault(); if (!busy && !mustReload) void save(); }} className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="editor-title" className="text-lg font-semibold">Review expense</h2>
        <button type="button" className={editorButton} disabled={busy} onClick={close}>Close</button>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-400">Check the values against your receipt. Saving also confirms an unchanged entry.</p>
      {!!entry.review_reasons?.length && <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">Original extraction warnings: {entry.review_reasons.map((r) => r.replaceAll("_", " ")).join(", ")}. These remain as history after review.</p>}
      {entry.drive_link ? <a className="inline-block py-2 text-sm text-teal-700 underline dark:text-teal-400" href={entry.drive_link} target="_blank" rel="noreferrer">Open original in Drive</a> : <p className="text-sm">Original link unavailable. You can still edit your ledger entry.</p>}
      {message && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{message}</p>}
      {mustReload && <div className="space-y-3 rounded-md border border-amber-400 p-3 text-sm">
        {latest ? <>
          <LatestValues entry={latest} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={editorButton} disabled={busy} onClick={() => {
              setBase(latest); setCurrencyConfirmed(false); setMustReload(false); setLatest(null); setMessage("Latest version loaded. Check your retained draft, then save.");
            }}>Keep my draft against this version</button>
            <button type="button" className={editorButton} disabled={busy} onClick={() => {
              if (dirty && !window.confirm("Replace your draft with the latest saved values?")) return;
              setBase(latest); setForm(entryForm(latest)); setErrors({}); setCurrencyConfirmed(false); setMustReload(false); setLatest(null); setMessage("");
            }}>Use latest saved values</button>
          </div>
        </> : <p>Reload the saved entry before retrying. Your draft will stay here.</p>}
        <button type="button" className={editorButton} disabled={busy} onClick={() => void reload()}>{busy ? "Loading…" : "Load latest entry"}</button>
      </div>}
      {categories.isError && <p role="alert" className="text-sm">Couldn't load categories. <button type="button" className="underline" onClick={() => void categories.refetch()}>Retry categories</button></p>}
      <fieldset disabled={busy || categories.isPending || categories.isError} className="space-y-4">
        <legend className="sr-only">Expense fields</legend>
        <EntryFields form={form} errors={errors} categories={categories.data ?? []} setForm={(next) => {
          if (next.currency !== form.currency) setCurrencyConfirmed(false);
          setForm(next);
        }} />
        {form.currency !== base.currency && <label className="flex items-start gap-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <input type="checkbox" className="mt-1 size-5 shrink-0" checked={currencyConfirmed} onChange={(e) => setCurrencyConfirmed(e.target.checked)} />
          I checked the total, tax and every line-item amount in {form.currency}. No currency conversion is applied.
        </label>}
        <button className="min-h-11 w-full rounded-md bg-teal-700 px-4 py-2 font-medium text-white hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-50" disabled={mustReload}>{busy ? "Saving…" : "Save review"}</button>
      </fieldset>
    </form>
  </dialog>;
}

function LatestValues({ entry: e }: { entry: LedgerDetail }) {
  return <div className="space-y-2 break-words">
    <h3 className="font-semibold">Latest saved values</h3>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {Object.entries({ Merchant: e.merchant, Date: e.txn_date, Time: e.txn_time ?? "Not recorded", Category: e.category_name,
        Total: formatMoney(e.total_minor, e.currency), Tax: e.tax_minor === null ? "Not recorded" : formatMoney(e.tax_minor, e.currency),
        Payment: e.payment_method ?? "Not recorded", Notes: e.notes ?? "Not recorded",
      }).map(([key, value]) => <div key={key} className="contents"><dt>{key}</dt><dd>{value}</dd></div>)}
    </dl>
    <p>Line items: {e.line_items?.length ? e.line_items.map((item) => `${item.description}: ${formatMoney(item.amount_minor, e.currency)}`).join("; ") : "Not recorded"}</p>
  </div>;
}
