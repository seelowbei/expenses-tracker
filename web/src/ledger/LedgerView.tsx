import type { LedgerDetail } from "../../../worker/src/contracts/ledger";
import { EntryEditor } from "./EntryEditor";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, listCategories, listLedger, type LedgerSummary } from "../api";
import { EntryDetail } from "./EntryDetail";
import { formatMoney, localDate, localMonth, monthLabel, monthRange, presetRange, rangeLabel, shiftMonth, type RangePreset } from "./format";
import { ChevronIcon, RefreshIcon } from "./icons";
import { SelectControl } from "./SelectControl";
import { summarizeTotals } from "./totals";

const PRESETS: { id: RangePreset; label: string }[] = [
  { id: "month", label: "This month" }, { id: "1m", label: "1 month" }, { id: "3m", label: "3 months" }, { id: "1y", label: "1 year" }, { id: "custom", label: "Custom" },
];
const SWATCHES = [
  "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200", "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200",
  "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200", "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200", "bg-lime-100 text-lime-900 dark:bg-lime-950 dark:text-lime-200",
];
const swatch = (id: string) => SWATCHES[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % SWATCHES.length];
/** Share of the currency total as a bar width; refunds or negative totals draw no bar. */
const share = (part: bigint, total: bigint) => (part > 0n && total > 0n ? Math.min(100, Number((part * 1000n) / total) / 10) : 0);

export function LedgerView({ account, onReviewed }: { account: string; onReviewed: () => void }) {
  const [editing, setEditing] = useState<LedgerDetail | null>(null);
  const [notice, setNotice] = useState("");
  const [preset, setPreset] = useState<RangePreset>("month");
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
  const choosePreset = (next: RangePreset) => {
    setPreset(next);
    if (next === "month") { selectMonth(localMonth()); return; }
    if (next !== "custom") { setRange(presetRange(next, localDate())); resetPage(); }
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
      {notice && <p role="status" className="rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800 dark:bg-teal-950 dark:text-teal-200">{notice}</p>}
      {editing && <EntryEditor entry={editing} account={account} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); setNotice("Review saved. Ledger totals updated."); onReviewed(); }}
        onRemoved={(confirmed) => {
          setEditing(null); resetPage(); onReviewed();
          setNotice(confirmed ? "Expense deleted. Ledger totals updated." : "This expense is no longer available.");
        }} />}

      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 id="ledger-heading" tabIndex={-1} className="text-lg font-semibold">Ledger</h2>
          <div role="group" aria-label="Date range" className="segmented">
            {PRESETS.map((p) => <button key={p.id} type="button" className="segment" aria-pressed={preset === p.id} onClick={() => choosePreset(p.id)}>{p.label}</button>)}
          </div>
        </div>
        {preset === "month" && <div className="flex items-center gap-2">
          <button className="btn btn-icon" aria-label="Previous month" disabled={month === "0001-01"} onClick={() => selectMonth(shiftMonth(month, -1))}><ChevronIcon dir="left" /></button>
          <label className="relative">
            <span className="sr-only">Month</span>
            <input className="field font-semibold" type="month" min="0001-01" max="9999-12" value={month} onChange={(e) => selectMonth(e.target.value)} />
          </label>
          <button className="btn btn-icon" aria-label="Next month" disabled={month === "9999-12"} onClick={() => selectMonth(shiftMonth(month, 1))}><ChevronIcon dir="right" /></button>
        </div>}
        {preset === "custom" && <form key={`${range.from}:${range.to}`} className="flex flex-wrap items-end gap-2 text-sm" onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const from = String(data.get("from"));
          setMonth(from.slice(0, 7)); setRange({ from, to: String(data.get("to")) }); resetPage();
        }}>
          <label className="min-w-36 flex-1 sm:flex-none">From<input className="field mt-1 block w-full" type="date" name="from" min="0001-01-01" max="9999-12-31" required defaultValue={range.from} /></label>
          <label className="min-w-36 flex-1 sm:flex-none">To<input className="field mt-1 block w-full" type="date" name="to" min="0001-01-01" max="9999-12-31" required defaultValue={range.to} /></label>
          <button className="btn btn-primary">Apply range</button>
          <span className="muted text-xs">Up to 12 calendar months</span>
        </form>}
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          <p className="mr-auto min-w-0">
            <span className="font-semibold">{preset === "month" ? monthLabel(month) : rangeLabel(range.from, range.to)}</span>
            <span className="muted block text-xs">{range.from} to {range.to} · Currencies shown separately</span>
          </p>
          <div className="flex w-full items-center gap-2 sm:w-auto">
          <label className="min-w-0 flex-1 text-sm">
            <span className="sr-only">Category</span>
            <SelectControl className="field w-full sm:w-48" value={category} disabled={categories.isPending || categories.isError} onChange={(e) => { setCategory(e.target.value); resetPage(); }}>
              <option value="">All categories</option>
              {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectControl>
          </label>
          <button className="btn btn-icon" aria-label="Refresh ledger" title="Refresh ledger" onClick={() => { resetPage(); void ledger.refetch(); }} disabled={ledger.isFetching}><RefreshIcon /></button>
          </div>
        </div>
        {categories.isError && <p role="alert" className="text-sm">Couldn't load categories. <button className="underline" onClick={() => void categories.refetch()}>Retry categories</button></p>}
      </div>

      {ledger.isPending ? <p role="status" className="muted">Loading ledger…</p> : ledger.isError ? (
        <p role="alert" className="card text-sm">{errorMessage} <button className="underline" onClick={() => void ledger.refetch()}>Retry ledger</button></p>
      ) : (
        <>
          {ledger.data.totals.length === 0 ? <p role="status" className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm muted dark:border-slate-700">No expenses in this range. Upload a receipt or choose another range.</p> : (
            <div className="space-y-2">
              <h3 className="sr-only">Totals for this range</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {summarizeTotals(ledger.data.totals).map((group) => <div key={group.currency} className="card space-y-3">
                  <h4>
                    <span className="muted block text-xs font-medium">{group.currency} total</span>
                    <span className="block text-2xl font-semibold tabular-nums">{formatMoney(group.total_minor, group.currency)}</span>
                  </h4>
                  <dl aria-label={`${group.currency} category subtotals`} className="space-y-2.5 text-sm">
                    {group.categories.map((c) => <div key={c.category_id}>
                      <div className="flex flex-wrap items-center justify-between gap-x-3">
                        <dt className="flex min-w-0 flex-wrap items-center gap-2 break-words">{c.category_name}
                          {c.needs_review_count > 0 && <span className="pill pill-amber">{c.needs_review_count} to review</span>}</dt>
                        <dd className="muted ml-auto tabular-nums">{formatMoney(c.total_minor, group.currency)}</dd>
                      </div>
                      <div aria-hidden="true" className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div className="h-full rounded-full bg-teal-600 dark:bg-teal-500" style={{ width: `${share(c.total_minor, group.total_minor)}%` }} />
                      </div>
                    </div>)}
                  </dl>
                </div>)}
              </div>
              <p className="muted text-xs">Totals include all matching entries, across every page.</p>
            </div>
          )}
          {[...groups].map(([id, group]) => <div key={id} className="card p-0">
            <h3 className="px-4 pt-3 pb-1 text-sm font-semibold">{group.name} <span className="muted font-normal">· {group.entries.length} {group.entries.length === 1 ? "entry" : "entries"}</span></h3>
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {group.entries.map((e) => <li key={e.id} className={selected === e.id ? "bg-slate-50 dark:bg-slate-800/50" : ""}>
                <button aria-expanded={selected === e.id} aria-controls={`entry-${e.id}`} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-teal-700 dark:hover:bg-slate-800/50" onClick={() => setSelected(selected === e.id ? null : e.id)}>
                  <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${swatch(e.category_id)}`}>{[...e.merchant.trim()][0]?.toUpperCase() ?? "?"}</span>
                  <span className="min-w-0 flex-1 break-words">
                    <span className="font-medium">{e.merchant}</span>
                    {e.receipt_status === "needs_review" && <span className="pill pill-amber ml-2">Needs review</span>}
                    <span className="muted block text-xs">{e.txn_date}{e.txn_time ? ` · ${e.txn_time}` : " · Time unknown"}</span>
                  </span>
                  <span className="text-right font-medium tabular-nums">{formatMoney(e.total_minor, e.currency)}</span>
                  <span className={`muted transition-transform ${selected === e.id ? "rotate-180" : ""}`}><ChevronIcon /></span>
                  <span className="sr-only">{selected === e.id ? "Hide details" : "View details"}</span>
                </button>
                <div id={`entry-${e.id}`} hidden={selected !== e.id}>{selected === e.id && <EntryDetail id={e.id} account={account} onEdit={(entry) => { setEditing(entry); setNotice(""); }} />}</div>
              </li>)}
            </ul>
          </div>)}
          {ledger.data.entries.length === 0 && ledger.data.totals.length > 0 && <p role="status" className="muted text-sm">No more entries on this page. Refresh to return to the first page.</p>}
          {(cursors.length > 1 || ledger.data.nextCursor) && <nav aria-label="Ledger pages" className="flex items-center justify-between gap-2">
            <button className="btn" disabled={cursors.length === 1 || ledger.isFetching} onClick={() => { setCursors((p) => p.slice(0, -1)); setSelected(null); }}>Previous</button>
            <span role="status" className="muted text-sm">Page {cursors.length}{ledger.isFetching ? " · Updating…" : ""}</span>
            <button className="btn" disabled={!ledger.data.nextCursor || ledger.isFetching} onClick={() => { setCursors((p) => [...p, ledger.data.nextCursor!]); setSelected(null); }}>Next</button>
          </nav>}
        </>
      )}
    </section>
  );
}
