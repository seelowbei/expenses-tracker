import type { ReviewDetail, ReviewDraft } from "../../../worker/src/contracts/review";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { LedgerDetail } from "../../../worker/src/contracts/ledger";
import type { CategoryDto } from "../../../worker/src/contracts/categories";
import { ApiError, createCategory, deleteLedgerEntry, getLedgerEntry, getReceiptDetail, createReceiptReview, listCategories, patchLedgerEntry } from "../api";
import { clearSession } from "../query-client";
import { CategoryCreate } from "./CategoryCreate";
import { EntryFields, editorButton } from "./EntryFields";
import { entryForm, formPatch, formCreate, type FormErrors } from "./form";
import { syncRemovedEntry, syncReviewedEntry } from "./review-cache";
import { ReceiptPreview } from "./ReceiptPreview";
import { formatMoney } from "./format";
import { AlertIcon, ExternalIcon, MoreIcon, TrashIcon } from "./icons";

const menuItem = "flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-slate-100 focus-visible:bg-slate-100 focus-visible:outline-none disabled:opacity-50 sm:min-h-9 dark:hover:bg-slate-800 dark:focus-visible:bg-slate-800";

type EditorProps = { focusTargetId?: string; account: string; onClose: () => void; onSaved: () => void; onRemoved: (confirmed: boolean) => void } & (
  { entry: LedgerDetail; review?: never } | { entry?: never; review: ReviewDetail & { draft: ReviewDraft } }
);
export function EntryEditor({ entry, review, account, onClose, onSaved, onRemoved, focusTargetId = "ledger-heading" }: EditorProps) {
  const qc = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const detailsPane = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<"receipt" | "details">("details");
  const active = useRef(true);
  const removed = useRef(false);
  const request = useRef<AbortController | null>(null);
  const [base, setBase] = useState<LedgerDetail | null>(entry ?? null);
  const [form, setForm] = useState(() => entryForm(entry ?? review?.draft ?? {}));
  const [errors, setErrors] = useState<FormErrors>({});
  const [reviewBusy, setBusy] = useState(false);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [checkingDelete, setCheckingDelete] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuWrap = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const keepButton = useRef<HTMLButtonElement>(null);
  const busy = reviewBusy || creatingCategory || deleting;
  const [currencyConfirmed, setCurrencyConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [mustReload, setMustReload] = useState(false);
  const [latest, setLatest] = useState<LedgerDetail | null>(null);
  const [canRetryCreate, setCanRetryCreate] = useState(false);
  const initial = base ?? review?.draft ?? {};
  const receiptId = base?.receipt_id ?? review?.receipt.id ?? null;
  const driveLink = base?.drive_link ?? review?.receipt.driveLink ?? null;
  const reasons = base?.review_reasons ?? review?.receipt.reviewReasons;
  const pending = (base?.receipt_status ?? review?.receipt.status) === "needs_review";
  const categoryKey = ["categories", account];
  const categories = useQuery({ queryKey: categoryKey, queryFn: ({ signal }) => listCategories(signal) });
  const dirty = JSON.stringify(form) !== JSON.stringify(entryForm(initial));
  useEffect(() => {
    active.current = true;
    const opener = document.activeElement;
    dialog.current?.showModal();
    return () => {
      active.current = false; request.current?.abort();
      // Wait for the saved row and pagination updates to finish before restoring focus.
      requestAnimationFrame(() => {
        if (!removed.current && opener instanceof HTMLElement && opener.isConnected && opener.tabIndex >= 0) opener.focus();
        else document.getElementById(focusTargetId)?.focus();
      });
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (message) { setPane("details"); detailsPane.current?.scrollTo({ top: 0 }); }
  }, [message]);
  useEffect(() => { if (confirmDelete) keepButton.current?.focus(); }, [confirmDelete]);
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const outside = (e: PointerEvent) => { if (!menuWrap.current?.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuOpen]);
  const closeMenu = () => { setMenuOpen(false); requestAnimationFrame(() => menuButton.current?.focus()); };
  const close = () => {
    if (menuOpen) { closeMenu(); return; }
    if (busy) return;
    if (confirmDelete) {
      setConfirmDelete(false);
      requestAnimationFrame(() => menuButton.current?.focus());
    } else if (!dirty || window.confirm("Discard your unsaved changes?")) onClose();
  };
  const addCategory = async (name: string) => {
    setCreatingCategory(true);
    const controller = new AbortController();
    request.current = controller;
    try {
      const category = await createCategory(name, controller.signal);
      await qc.cancelQueries({ queryKey: categoryKey });
      if (!active.current || qc.getQueryData<{ email: string } | null>(["me"])?.email !== account) return false;
      qc.setQueryData<CategoryDto[]>(categoryKey, (rows = []) => rows.some((row) => row.id === category.id) ? rows : [...rows, category]);
      setForm((draft) => ({ ...draft, category_id: category.id }));
      setErrors(({ category_id, ...remaining }) => remaining);
      void qc.invalidateQueries({ queryKey: categoryKey });
      return true;
    } catch (error) {
      if (!active.current || qc.getQueryData<{ email: string } | null>(["me"])?.email !== account) return false;
      if (!(error instanceof ApiError) || error.status !== 401) void qc.invalidateQueries({ queryKey: categoryKey });
      throw error;
    } finally {
      if (active.current) setCreatingCategory(false);
    }
  };
  const finishRemoval = async (entry: LedgerDetail, confirmed: boolean) => {
    if (!await syncRemovedEntry(qc, account, entry, confirmed) || !active.current) return;
    removed.current = true;
    onRemoved(confirmed);
  };
  const reload = async (afterDelete = checkingDelete) => {
    setBusy(true); setLatest(null); setCanRetryCreate(false);
    request.current = new AbortController();
    try {
      let fresh: LedgerDetail | null = null;
      if (base) fresh = await getLedgerEntry(base.id, request.current.signal);
      else if (review) {
        const detail = await getReceiptDetail(review.receipt.id, request.current.signal);
        if (detail.entryId) fresh = await getLedgerEntry(detail.entryId, request.current.signal);
        else if (active.current) {
          setCanRetryCreate(detail.draft !== null);
          setMessage(detail.draft !== null ? "No entry was saved. Your draft is retained; you can retry after checking it."
            : "This receipt is no longer awaiting review. Your draft is retained, but a new entry cannot be created.");
        }
      }
      if (active.current && fresh) {
        setLatest(fresh);
        qc.setQueryData(["ledger-detail", account, fresh.id], fresh);
        for (const key of ["ledger", "receipts", "review", "receipt-detail"]) void qc.invalidateQueries({ queryKey: [key, account] });
      }
    } catch (e) {
      if (!active.current) return;
      if (e instanceof ApiError && e.status === 401) clearSession(qc);
      else if (afterDelete && base && e instanceof ApiError && e.status === 404) await finishRemoval(base, false);
      else setMessage("Couldn't reload the saved state. Your draft is retained. Try loading it again.");
    } finally { if (active.current) setBusy(false); }
  };
  const remove = async () => {
    if (!base || busy || mustReload) return;
    setDeleting(true);
    setMessage("");
    const controller = new AbortController();
    request.current = controller;
    try {
      await deleteLedgerEntry(base.id, base.updated_at, controller.signal);
      if (active.current) await finishRemoval(base, true);
    } catch (e) {
      if (!active.current) return;
      if (e instanceof ApiError && e.status === 401) { clearSession(qc); return; }
      setConfirmDelete(false);
      setCheckingDelete(true);
      setMustReload(true);
      setMessage(e instanceof ApiError && e.code === "entry_changed"
        ? "This expense changed in another tab. Check the latest saved values before confirming deletion again."
        : e instanceof ApiError && e.code === "receipt_busy"
          ? "This receipt is still processing. Check the saved state again when it finishes."
          : "Couldn't confirm the deletion. Your draft is retained while we check the saved state.");
      await reload(true);
    } finally { if (active.current) setDeleting(false); }
  };
  const save = async () => {
    setPane("details");
    const result = base ? formPatch(form, base, currencyConfirmed) : formCreate(form, initial.currency ?? "", currencyConfirmed);
    if (result.errors) { setErrors(result.errors); setMessage("Check the highlighted fields."); return; }
    setErrors({}); setMessage(""); setBusy(true);
    request.current = new AbortController();
    try {
      const saved = "patch" in result && result.patch && base
        ? await patchLedgerEntry(base.id, result.patch, request.current.signal)
        : "body" in result && result.body && review
          ? await createReceiptReview(review.receipt.id, result.body, request.current.signal)
          : null;
      if (!saved) return;
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
    className="fixed inset-0 m-auto h-dvh max-h-none w-full max-w-none overflow-hidden border-0 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/60 lg:h-[92dvh] lg:w-[94vw] lg:max-w-7xl lg:rounded-xl lg:border lg:border-slate-200 dark:bg-slate-900 dark:text-slate-100 lg:dark:border-slate-700">
    <form inert={confirmDelete} noValidate onSubmit={(e) => { e.preventDefault(); if (!busy && !mustReload && !confirmDelete) void save(); }} className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-4 py-3 sm:px-6 dark:border-slate-700">
        <div className="min-w-0">
          <h2 id="editor-title" className="text-lg font-semibold">Review expense</h2>
          <p className="truncate text-sm text-slate-500 dark:text-slate-400">{initial.merchant || "Receipt review"} · {initial.txn_date || "Date needed"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {base && <div ref={menuWrap} className="relative" onBlur={(e) => { if (menuOpen && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setMenuOpen(false); }}>
            <button ref={menuButton} type="button" className="btn btn-icon" aria-label="More actions" title="More actions" aria-haspopup="menu" aria-expanded={menuOpen}
              aria-controls={menuOpen ? "editor-menu" : undefined} disabled={busy} onClick={() => setMenuOpen((open) => !open)}><MoreIcon /></button>
            {menuOpen && <div ref={menu} id="editor-menu" role="menu" aria-label="More actions" className="absolute right-0 top-full z-30 mt-1 w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
              onKeyDown={(e) => {
                if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                e.preventDefault();
                const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
                const i = items.indexOf(document.activeElement as HTMLElement);
                items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
              }}>
              {driveLink && <a role="menuitem" href={driveLink} target="_blank" rel="noreferrer" className={menuItem} onClick={closeMenu}><ExternalIcon />View in Drive</a>}
              {driveLink && <div role="separator" className="my-1 border-t border-slate-200 dark:border-slate-700" />}
              <button role="menuitem" type="button" className={`${menuItem} text-red-700 dark:text-red-300`} disabled={mustReload}
                onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}><TrashIcon />Delete expense…</button>
            </div>}
          </div>}
          <button type="button" className={editorButton} disabled={busy} onClick={close}>Close</button>
        </div>
      </header>
      <nav aria-label="Review views" className="grid shrink-0 grid-cols-2 border-b border-slate-200 p-2 lg:hidden dark:border-slate-700">
        {(["receipt", "details"] as const).map((view) => <button key={view} type="button" aria-pressed={pane === view}
          className={`min-h-11 rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-teal-700 ${pane === view ? "bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200" : "text-slate-600 dark:text-slate-400"}`} onClick={() => setPane(view)}>{view === "receipt" ? "Receipt" : "Expense details"}</button>)}
      </nav>
      <div className="min-h-0 flex-1 lg:grid lg:grid-cols-2">
        <div className={`${pane === "receipt" ? "block" : "hidden"} h-full min-h-0 min-w-0 border-slate-200 lg:block lg:border-r dark:border-slate-700`}>
          <ReceiptPreview receiptId={receiptId} driveLink={driveLink} />
        </div>
        <div ref={detailsPane} className={`${pane === "details" ? "block" : "hidden"} h-full min-h-0 min-w-0 space-y-5 overflow-y-auto p-4 sm:p-6 lg:block`}>
          <div>
            <h3 className="font-semibold">Expense details</h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{base ? "Check these values against the receipt. You can confirm them without making changes." : "Some fields could not be read. Complete the required details to add this expense to your ledger."}</p>
          </div>
          {!!reasons?.length && <details open={pending} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <summary className="cursor-pointer py-1 font-medium">{pending ? "What to check" : "Original extraction warnings"}</summary>
            <p className="pb-1 pt-2">{reasons.map((r) => r.replaceAll("_", " ")).join(", ")}. Retained as history after review.</p>
          </details>}
          {message && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{message}</p>}
          {mustReload && <div className="space-y-3 rounded-md border border-amber-400 p-3 text-sm">
            {latest ? <>
              <LatestValues entry={latest} />
              <div className="flex flex-wrap gap-2">
                <button type="button" className={editorButton} disabled={busy} onClick={() => {
                  setBase(latest); setCurrencyConfirmed(false); setMustReload(false); setLatest(null); setCheckingDelete(false); setMessage("Latest version loaded. Your draft is still here.");
                }}>Keep my draft against this version</button>
                <button type="button" className={editorButton} disabled={busy} onClick={() => {
                  if (dirty && !window.confirm("Replace your draft with the latest saved values?")) return;
                  setBase(latest); setForm(entryForm(latest)); setErrors({}); setCurrencyConfirmed(false); setMustReload(false); setLatest(null); setCheckingDelete(false); setMessage("");
                }}>Use latest saved values</button>
              </div>
            </> : <p>{canRetryCreate ? "The receipt is still awaiting review. Check your draft before retrying." : "Reload the saved state before retrying. Your draft will stay here."}</p>}
            {canRetryCreate && <button type="button" className={editorButton} disabled={busy} onClick={() => {
              setMustReload(false); setCanRetryCreate(false); setMessage("Check your retained draft, then save again.");
            }}>Check draft and retry</button>}
            <button type="button" className={editorButton} disabled={busy} onClick={() => void reload()}>{busy ? "Loading…" : "Load latest saved state"}</button>
          </div>}
          {categories.isError && <p role="alert" className="text-sm">Couldn't load categories. <button type="button" className="underline" onClick={() => void categories.refetch()}>Retry categories</button></p>}
          <fieldset disabled={busy || confirmDelete || categories.isPending || categories.isError} className="space-y-4">
            <legend className="sr-only">Expense fields</legend>
            <EntryFields form={form} errors={errors} categories={categories.data ?? []}
              categoryAction={<CategoryCreate onCreate={addCategory} onSessionExpired={() => clearSession(qc)} />} setForm={(next) => {
              if (next.currency !== form.currency) setCurrencyConfirmed(false);
              setForm(next);
            }} />
            {form.currency !== (initial.currency ?? "") && <label className="flex items-start gap-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <input type="checkbox" className="mt-1 size-5 shrink-0" checked={currencyConfirmed} onChange={(e) => setCurrencyConfirmed(e.target.checked)} />
              I checked the total, tax and every line-item amount in {form.currency}. No currency conversion is applied.
            </label>}
          </fieldset>
        </div>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white px-4 py-3 sm:px-6 dark:border-slate-700 dark:bg-slate-900">
          <p className="text-xs text-slate-500 dark:text-slate-400" role="status">{creatingCategory ? "Creating category…" : reviewBusy ? "Saving your review…" : dirty ? "You have unsaved changes" : "Ready to confirm these details"}</p>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className={editorButton} disabled={busy} onClick={close}>Cancel</button>
            <button className="btn btn-primary px-5" disabled={busy || mustReload || categories.isPending || categories.isError}>{reviewBusy ? "Saving…" : "Save review"}</button>
          </div>
      </footer>
    </form>
    {confirmDelete && base && <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/50 p-4">
      <div role="alertdialog" aria-modal="true" aria-labelledby="delete-expense-title" aria-describedby="delete-expense-effect"
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex gap-3">
          <span className="mt-0.5 text-red-700 dark:text-red-300"><AlertIcon /></span>
          <div className="min-w-0">
            <h3 id="delete-expense-title" className="font-semibold">Delete this expense?</h3>
            <p id="delete-expense-effect" className="mt-1 break-words text-sm text-slate-600 dark:text-slate-400">
              {base.merchant} · {formatMoney(base.total_minor, base.currency)} will be removed from your ledger and totals.{receiptId && " The original receipt stays in Google Drive."}{dirty && " Unsaved changes will be discarded."} This can't be undone.
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button ref={keepButton} type="button" className={editorButton} disabled={busy} onClick={close}>Keep expense</button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete permanently"}</button>
        </div>
      </div>
    </div>}
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
