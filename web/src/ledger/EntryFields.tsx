import type { CategoryDto } from "../../../worker/src/contracts/categories";
import { CurrencySelect } from "./CurrencySelect";
import { SelectControl } from "./SelectControl";
import type { EntryForm, FormErrors } from "./form";

export const editorControl = "min-h-11 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900";
export const editorButton = "min-h-11 rounded-md border border-slate-300 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-50 dark:border-slate-600";

export function EntryFields({ form, setForm, errors, categories }: {
  form: EntryForm; setForm: (form: EntryForm) => void; errors: FormErrors; categories: CategoryDto[];
}) {
  const a11y = (field: string) => ({ id: `edit-${field}`, "aria-invalid": !!errors[field], "aria-describedby": errors[field] ? `error-${field}` : undefined });
  const error = (field: string) => errors[field] && <span id={`error-${field}`} className="block text-sm text-red-700 dark:text-red-300">{errors[field]}</span>;
  const input = (field: Exclude<keyof EntryForm, "line_items">, label: string, type = "text", maxLength?: number) => (
    <label className="block min-w-0 space-y-1 text-sm">{label}
      <input {...a11y(field)} className={editorControl} type={type} maxLength={maxLength} inputMode={field === "total" || field === "tax" ? "decimal" : undefined}
        value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value })} />{error(field)}
    </label>
  );
  return <div className="space-y-4">
    {input("merchant", "Merchant", "text", 120)}
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">{input("txn_date", "Date", "date")}{input("txn_time", "Time (optional)", "time")}</div>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="block min-w-0 space-y-1 text-sm">Category
        <SelectControl {...a11y("category_id")} className={editorControl} value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
          <option value="" disabled>Choose a category</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectControl>{error("category_id")}
      </label>
      <CurrencySelect value={form.currency} onChange={(currency) => setForm({ ...form, currency })} className={editorControl} error={errors.currency} />
    </div>
    <div className="grid gap-4 sm:grid-cols-2">{input("total", `Total (${form.currency})`)}{input("tax", `Tax (${form.currency}, optional)`)}</div>
    <label className="block space-y-1 text-sm">Payment method (optional)
      <SelectControl {...a11y("payment_method")} className={editorControl} value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })}>
        <option value="">Not recorded</option>{["cash", "card", "ewallet", "bank_transfer", "other"].map((method) => <option key={method} value={method}>{method.replaceAll("_", " ")}</option>)}
      </SelectControl>{error("payment_method")}
    </label>
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">Line items (optional, {form.currency})</legend>
      {form.line_items.map((item, i) => <div key={i} className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-700">
        <label className="block space-y-1 text-sm">Description {i + 1}
          <input {...a11y(`line_items.${i}.description`)} className={editorControl} maxLength={200} value={item.description} onChange={(e) => setForm({ ...form, line_items: form.line_items.map((v, n) => n === i ? { ...v, description: e.target.value } : v) })} />{error(`line_items.${i}.description`)}
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 space-y-1 text-sm">Amount {i + 1}
            <input {...a11y(`line_items.${i}.amount`)} className={editorControl} inputMode="decimal" value={item.amount} onChange={(e) => setForm({ ...form, line_items: form.line_items.map((v, n) => n === i ? { ...v, amount: e.target.value } : v) })} />{error(`line_items.${i}.amount`)}
          </label>
          <button type="button" className={editorButton} aria-label={`Remove line item ${i + 1}`} onClick={() => setForm({ ...form, line_items: form.line_items.filter((_, n) => n !== i) })}>Remove</button>
        </div>
      </div>)}
      {error("line_items")}
      <button type="button" className={editorButton} disabled={form.line_items.length >= 50} onClick={() => setForm({ ...form, line_items: [...form.line_items, { description: "", amount: "" }] })}>Add line item</button>
      <p className="text-xs text-slate-600 dark:text-slate-400">Use negative amounts for discounts. Up to 50 items.</p>
    </fieldset>
    <label className="block space-y-1 text-sm">Notes (optional)
      <textarea {...a11y("notes")} className={editorControl} rows={3} maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />{error("notes")}
    </label>
  </div>;
}
