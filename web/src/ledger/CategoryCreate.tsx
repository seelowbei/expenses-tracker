import { useRef, useState } from "react";
import { CATEGORY_NAME_MAX } from "../../../worker/src/contracts/categories";
import { ApiError } from "../api-error";
import { editorButton, editorControl } from "./EntryFields";

export function CategoryCreate({ onCreate, onSessionExpired }: {
  onCreate: (name: string) => Promise<boolean>;
  onSessionExpired: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setName("");
    setError("");
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const add = async () => {
    setError("");
    try {
      if (await onCreate(name.trim())) close();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSessionExpired();
      else setError(e instanceof ApiError && e.code === "category_exists"
        ? "A category with this name or a similar name already exists."
        : e instanceof ApiError && e.code === "invalid_body"
          ? "Enter a valid category name."
          : "Couldn't confirm category creation. Check the category list before trying again.");
    }
  };

  if (!open) return <button ref={trigger} type="button" className={editorButton} onClick={() => setOpen(true)}>New category</button>;
  return <div className="space-y-2 rounded-md border border-slate-300 p-3 dark:border-slate-600">
    <label className="block space-y-1 text-sm">Category name
      <input autoFocus className={editorControl} maxLength={CATEGORY_NAME_MAX} value={name}
        aria-invalid={!!error} aria-describedby={error ? "category-create-error" : undefined}
        onChange={(e) => { setName(e.target.value); setError(""); }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (name.trim()) void add();
        }} />
    </label>
    {error && <p id="category-create-error" role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={editorButton} onClick={() => void add()} disabled={!name.trim()}>Create category</button>
      <button type="button" className={editorButton} onClick={close}>Cancel category</button>
    </div>
  </div>;
}
