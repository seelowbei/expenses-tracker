import { useEffect, useId, useRef, useState } from "react";
import { supportedCurrencies } from "../../../worker/src/contracts/ledger-write";
import { SelectChevron } from "./SelectControl";

const names = new Intl.DisplayNames(["en"], { type: "currency" });
const currencies = supportedCurrencies.map((code) => ({ code, name: names.of(code) ?? code }));

export function CurrencySelect({ value, onChange, className, error }: {
  value: string; onChange: (code: string) => void; className: string; error?: string;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(-1);
  const query = search.trim().toLowerCase();
  const matches = currencies.filter(({ code, name }) => `${code} ${name}`.toLowerCase().includes(query));
  const selected = currencies.find(({ code }) => code === value);
  const show = () => { setOpen(true); setSearch(""); setActive(-1); };
  const choose = (code: string) => {
    if (input.current?.matches(":disabled")) return;
    onChange(code); setOpen(false);
  };
  useEffect(() => {
    if (open && active >= 0) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  return <div className="min-w-0 space-y-1 text-sm">
    <label htmlFor="edit-currency">Currency</label>
    <div className="relative">
      <input ref={input} id="edit-currency" role="combobox" aria-autocomplete="list" aria-expanded={open}
        aria-controls={open ? listId : undefined} aria-activedescendant={open && active >= 0 && matches[active] ? `${listId}-${matches[active].code}` : undefined}
        aria-invalid={!!error} aria-describedby={error ? "error-currency" : undefined}
        autoComplete="off" spellCheck={false} placeholder="Search code or currency name" className={`${className} pr-10`}
        value={open ? search : selected ? `${selected.code} — ${selected.name}` : value ? `${value} — choose a currency` : ""}
        onFocus={show} onClick={() => { if (!open) show(); }} onBlur={() => setOpen(false)}
        onChange={(e) => { setSearch(e.target.value); setActive(-1); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
          else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) { show(); return; }
            setActive((i) => e.key === "ArrowDown" ? Math.min(i + 1, matches.length - 1) : i < 0 ? matches.length - 1 : Math.max(0, i - 1));
          } else if (e.key === "Enter" && open) {
            e.preventDefault();
            const option = matches[active] ?? (matches.length === 1 ? matches[0] : undefined);
            if (option) choose(option.code);
          }
        }} />
      <SelectChevron />
      {open && <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-slate-300 bg-white shadow-lg dark:border-slate-600 dark:bg-slate-900">
        <ul ref={list} id={listId} role="listbox" aria-label="Currencies" className="max-h-56 overflow-y-auto overscroll-contain p-1">
          {matches.map(({ code, name }, i) => <li key={code} id={`${listId}-${code}`} role="option" aria-selected={active === i}
            className={`flex min-h-11 cursor-pointer items-center gap-3 rounded px-3 py-2 ${active === i ? "bg-teal-100 text-teal-950 outline outline-teal-700 dark:bg-teal-900 dark:text-teal-50" : "hover:bg-slate-100 dark:hover:bg-slate-800"}`}
            onMouseDown={(e) => e.preventDefault()} onClick={() => choose(code)}>
            <span className="font-medium">{code}</span><span className="min-w-0 flex-1">{name}</span>
            {code === value && <span aria-label="Current currency">✓</span>}
          </li>)}
        </ul>
        {!matches.length && <p role="status" className="px-4 py-3 text-slate-600 dark:text-slate-400">No currencies found. Try a code like SGD or a name.</p>}
      </div>}
    </div>
    {error && <span id="error-currency" className="block text-sm text-red-700 dark:text-red-300">{error}</span>}
  </div>;
}
