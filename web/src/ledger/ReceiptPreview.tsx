import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, getReceiptFile } from "../api";
import { clearSession } from "../query-client";
import { editorButton } from "./EntryFields";

export function ReceiptPreview({ receiptId, driveLink }: { receiptId: string | null; driveLink: string | null }) {
  const client = useQueryClient();
  const [file, setFile] = useState<{ url: string; type: string } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(100);
  useEffect(() => {
    if (!receiptId) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setFile(null); setError(""); setZoom(100);
    void getReceiptFile(receiptId, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setFile({ url: objectUrl, type: blob.type });
    }).catch((e: unknown) => {
      if (controller.signal.aborted) return;
      if (e instanceof ApiError && e.status === 401) { clearSession(client); return; }
      setError(e instanceof ApiError && e.code === "receipt_file_missing"
        ? "The original receipt is no longer available in Drive."
        : "We couldn't load the receipt. Try again or open it in Drive.");
    });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [receiptId, attempt, client]);
  return <section aria-label="Original receipt" className="flex h-full min-h-0 flex-col bg-slate-100 dark:bg-slate-950">
    <div className="flex min-h-16 flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
      <h3 className="text-sm font-semibold">Original receipt</h3>
      {driveLink && <a className="text-sm text-teal-700 underline underline-offset-4 dark:text-teal-400" href={driveLink} target="_blank" rel="noreferrer">Open in Drive ↗</a>}
    </div>
    {file?.type.startsWith("image/") && <div className="flex items-center justify-center gap-3 border-b border-slate-200 px-4 py-2 dark:border-slate-800">
      <button type="button" className={editorButton} aria-label="Zoom out" disabled={zoom <= 50} onClick={() => setZoom((z) => z - 25)}>−</button>
      <span className="w-12 text-center text-xs tabular-nums" aria-live="polite">{zoom}%</span>
      <button type="button" className={editorButton} aria-label="Zoom in" disabled={zoom >= 300} onClick={() => setZoom((z) => z + 25)}>+</button>
      <button type="button" className={editorButton} onClick={() => setZoom(100)}>Fit width</button>
    </div>}
    <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-5" tabIndex={0} aria-label="Receipt viewer">
      {!receiptId || error ? <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm font-medium" role={error ? "alert" : undefined}>{error || "No receipt is attached to this entry."}</p>
        <p className="text-sm text-slate-600 dark:text-slate-400">You can still review and save the expense details.</p>
        {receiptId && <button type="button" className={editorButton} onClick={() => setAttempt((a) => a + 1)}>Retry preview</button>}
      </div> : !file ? <div role="status" className="flex h-full items-center justify-center text-sm text-slate-500">Loading your receipt…</div>
        : file.type === "application/pdf" ? <iframe title="Original receipt PDF" src={file.url} className="h-full min-h-96 w-full rounded-md border-0 bg-white" />
          : <img src={file.url} alt="Original receipt" className="mx-auto block max-w-none rounded-sm bg-white shadow-sm" style={{ width: `${zoom}%` }} onError={() => setError("This image couldn't be displayed. Open the original in Drive or retry.")} />}
    </div>
  </section>;
}
