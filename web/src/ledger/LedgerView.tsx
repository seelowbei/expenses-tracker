import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, listCategories, listLedger, type LedgerSummary } from "../api";
import { EntryDetail } from "./EntryDetail";
import { formatMoney, localMonth, monthRange, shiftMonth } from "./format";

const control = "min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900";

export function LedgerView({ account }: { account: string }) {
  const [month, setMonth] = useState(localMonth);
  const [range, setRange] = useState(() => monthRange(localMonth()));
  const [category, setCategory] = useState("");
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<string | null>(null);
  const categories = useQuery({ queryKey: ["categories", account], queryFn: ({ signal }) => listCategories(signal) });
  const filters = { ...range, ...(category ? { category } : {}) };
  const cursor = cursors[cursors.length - 1];
  const ledger = useQuery({ queryKey: ["ledger", account, filters, cursor], queryFn: ({ signal }) => listLedger(filters, cursor, signal) });
  const resetPage = () => { setCursors([undefined]); setSelected(null); };
  const selectMonth = (value: string) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return;
    setMonth(value); setRange(monthRange(value)); resetPage();
  };
  const groups = new Map<string, { name: string; entries: LedgerSummary[] }>();
  for (const e of ledger.data?.entries ?? []) {
    const group = groups.get(e.category_id) ?? { name: e.category_name, entries: [] };
    group.entries.push(e); groups.set(e.category_id, group);
  }
  const errorMessage = ledger.error instanceof ApiError && ledger.error.code === "invalid_filters"
    ? "Choose a valid date range covering no more than 12 calendar months."
    : ledger.error instanceof ApiError && ledger.error.code === "amount_out_of_range"
      ? "An amount is too large to display safely. Try a narrower date range."
      : "Couldn't load your ledger. Try again.";

  return (
    <section aria-labelledby="ledger-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ledger-heading" className="text-lg font-semibold">Ledger</h2>
        <button className={control} onClick={() => { resetPage(); void ledger.refetch(); }} disabled={ledger.isFetching}>Refresh ledger</button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <button className={control} aria-label="Previous month" disabled={month === "0001-01"} onClick={() => selectMonth(shiftMonth(month, -1))}>←</button>
        <label className="min-w-0 flex-1 text-sm">Month
          <input className={`${control} mt-1 block w-full`} type="month" min="0001-01" max="9999-12" value={month} onChange={(e) => selectMonth(e.target.value)} />
        </label>
        <button className={control} aria-label="Next month" disabled={month === "9999-12"} onClick={() => selectMonth(shiftMonth(month, 1))}>→</button>
        <label className="w-full text-sm sm:w-auto">Category
          <span className="relative mt-1 block">
            <select className={`${control} block w-full appearance-none pr-10 sm:max-w-56 forced-colors:appearance-auto`} value={category} disabled={categories.isPending || categories.isError} onChange={(e) => { setCategory(e.target.value); resetPage(); }}>
              <option value="">All categories</option>
              {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <svg aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 forced-colors:hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </span>
        </label>
      </div>
      {categories.isError && <p role="alert" className="text-sm">Couldn't load categories. <button className="underline" onClick={() => void categories.refetch()}>Retry categories</button></p>}
      <details className="text-sm">
        <summary className="cursor-pointer py-2 text-teal-700 dark:text-teal-400">Choose a date range</summary>
        <form key={`${range.from}:${range.to}`} className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const from = String(data.get("from"));
          setMonth(from.slice(0, 7)); setRange({ from, to: String(data.get("to")) }); resetPage();
        }}>
          <label className="min-w-0 flex-1">From<input className={`${control} mt-1 block w-full`} type="date" name="from" min="0001-01-01" max="9999-12-31" required defaultValue={range.from} /></label>
          <label className="min-w-0 flex-1">To<input className={`${control} mt-1 block w-full`} type="date" name="to" min="0001-01-01" max="9999-12-31" required defaultValue={range.to} /></label>
          <button className={control}>Apply range</button>
        </form>
      </details>
      <p className="text-sm text-slate-600 dark:text-slate-400">{range.from} to {range.to} · Currencies shown separately</p>
      {ledger.isPending ? <p role="status">Loading ledger…</p> : ledger.isError ? (
        <p role="alert">{errorMessage} <button className="underline" onClick={() => void ledger.refetch()}>Retry ledger</button></p>
      ) : (
        <>
          {ledger.data.totals.length === 0 ? <p role="status" className="rounded-lg border border-dashed border-slate-300 p-5 text-sm dark:border-slate-700">No expenses in this range. Upload a receipt or choose another month.</p> : (
            <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <h3 className="font-medium">Totals for this range</h3>
              <ul className="space-y-2 text-sm">
                {ledger.data.totals.map((t) => <li key={`${t.category_id}:${t.month}:${t.currency}`} className="flex flex-wrap justify-between gap-x-4">
                  <span>{t.category_name} <span className="text-slate-600 dark:text-slate-400">· {t.month}</span>{t.needs_review_count > 0 && <span className="block text-xs text-amber-800 dark:text-amber-300">Includes {t.needs_review_count} needing review</span>}</span>
                  <span className="font-medium tabular-nums">{formatMoney(t.total_minor, t.currency)}</span>
                </li>)}
              </ul>
              <p className="text-xs text-slate-600 dark:text-slate-400">Totals include all matching entries, across every page.</p>
            </div>
          )}
          {[...groups].map(([id, group]) => <div key={id} className="space-y-2">
            <h3 className="font-medium">{group.name}</h3>
            <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {group.entries.map((e) => <li key={e.id}>
                <button aria-expanded={selected === e.id} aria-controls={`entry-${e.id}`} className="flex w-full flex-wrap items-start justify-between gap-2 px-4 py-3 text-left text-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-700 dark:hover:bg-slate-800" onClick={() => setSelected(selected === e.id ? null : e.id)}>
                  <span className="min-w-0 flex-1 break-words"><span className="font-medium">{e.merchant}</span><span className="block text-xs text-slate-600 dark:text-slate-400">{e.txn_date}{e.txn_time ? ` · ${e.txn_time}` : " · Time unknown"}</span>{e.receipt_status === "needs_review" && <span className="block text-xs text-amber-800 dark:text-amber-300">Needs review</span>}</span>
                  <span className="text-right tabular-nums">{formatMoney(e.total_minor, e.currency)}<span className="block text-xs text-teal-700 dark:text-teal-400">{selected === e.id ? "Hide details" : "View details"}</span></span>
                </button>
                <div id={`entry-${e.id}`} hidden={selected !== e.id}>{selected === e.id && <EntryDetail id={e.id} account={account} />}</div>
              </li>)}
            </ul>
          </div>)}
          {ledger.data.entries.length === 0 && ledger.data.totals.length > 0 && <p role="status">No more entries on this page. Refresh to return to the first page.</p>}
          <nav aria-label="Ledger pages" className="flex items-center justify-between gap-2">
            <button className={control} disabled={cursors.length === 1 || ledger.isFetching} onClick={() => { setCursors((p) => p.slice(0, -1)); setSelected(null); }}>Previous</button>
            <span role="status" className="text-sm">Page {cursors.length}{ledger.isFetching ? " · Updating…" : ""}</span>
            <button className={control} disabled={!ledger.data.nextCursor || ledger.isFetching} onClick={() => { setCursors((p) => [...p, ledger.data.nextCursor!]); setSelected(null); }}>Next</button>
          </nav>
        </>
      )}
    </section>
  );
}
