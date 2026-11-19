import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ReceiptListItem } from "../../worker/src/contracts/review";
import { ApiError, getMe, listReceipts, logout, retryReceipt, uploadReceipt, type Me, type Receipt } from "./api";
import { prepareFile, PrepareError } from "./prepare";
import { ReviewInbox } from "./ledger/ReviewInbox";
import { LedgerView } from "./ledger/LedgerView";
import { clearSession } from "./query-client";

const SIGN_IN_ERRORS: Record<string, string> = {
  not_allowed: "This Google account isn't allowed to use the app.",
  access_denied: "Sign-in was cancelled.",
  drive_scope_missing: "Google Drive access is needed to store receipts. Sign in again and keep the Drive box ticked.",
  no_refresh_token: "Google didn't grant offline access. Remove the app at myaccount.google.com/permissions and sign in again.",
  auth_expired: "The sign-in took too long. Please try again.",
  drive_disconnected: "Google Drive was disconnected. Sign in again to reconnect.",
};

function takeUrlError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("error");
  if (!code) return null;
  url.searchParams.delete("error");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  return SIGN_IN_ERRORS[code] ?? "Sign-in failed. Please try again.";
}

export function App() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState(takeUrlError);
  const me = useQuery({ queryKey: ["me"], queryFn: getMe });
  useEffect(() => {
    if (me.isSuccess) qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" && q.queryKey[1] !== me.data?.email });
  }, [qc, me.isSuccess, me.data?.email]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
          <img src="/logo.svg" alt="" className="size-8" />
          <h1 className="text-base font-semibold">Expense Tracker</h1>
          {me.data && <Account me={me.data} />}
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-5 sm:py-6">
      {notice && (
        <p role="alert" className="mb-5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          {notice}
        </p>
      )}

      {me.isPending ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : me.isError ? (
        <p className="text-sm text-red-600">Couldn't reach the server. Try again shortly.</p>
      ) : me.data ? (
        <Home key={me.data.email} me={me.data} onSignedOut={(msg) => setNotice(msg)} />
      ) : (
        <SignIn />
      )}
      </div>
    </div>
  );
}

function SignIn() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <img src="/logo.svg" alt="" className="size-16" />
      <p className="muted max-w-sm">Upload receipts; they're saved to your Google Drive and added to your ledger.</p>
      <a href="/auth/google" className="btn btn-primary px-5">
        Sign in with Google
      </a>
    </main>
  );
}

function Account({ me }: { me: Me }) {
  const qc = useQueryClient();
  const out = useMutation({ mutationFn: logout, onSettled: () => clearSession(qc) });
  return (
    <div className="ml-auto flex items-center gap-3 text-sm">
      <span className="muted hidden sm:inline">{me.name ?? me.email}</span>
      <button onClick={() => out.mutate()} disabled={out.isPending} className="btn">
        Sign out
      </button>
    </div>
  );
}

type UploadState = { name: string; state: "preparing" | "uploading" | "done" | "error"; message?: string };

function Home({ me, onSignedOut }: { me: Me; onSignedOut: (msg: string) => void }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [reviewRevision, setReviewRevision] = useState(0);
  const reviewed = () => setReviewRevision(value => value + 1);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  // Poll every 3 s while a receipt is being worked on (spec "API"). Stops when none is, and after
  // POLL_CAP_MS without any change, so a receipt stuck by a crash can't poll all day; an upload restarts it.
  const lastChange = useRef({ sig: "", at: 0 });
  const receipts = useQuery({
    queryKey: ["receipts", me.email],
    queryFn: ({ signal }) => listReceipts(signal),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return false;
      const sig = data.map((r) => `${r.id}:${r.status}:${r.error ?? ""}`).join("|");
      if (sig !== lastChange.current.sig) lastChange.current = { sig, at: Date.now() };
      return data.some(isWorking) && Date.now() - lastChange.current.at < POLL_CAP_MS ? POLL_MS : false;
    },
  });

  const completed = receipts.data?.filter((r) => r.status === "done" || r.status === "needs_review").map((r) => `${r.id}:${r.status}`).join("|");
  useEffect(() => {
    if (completed !== undefined) {
      void qc.invalidateQueries({ queryKey: ["ledger", me.email] });
      void qc.invalidateQueries({ queryKey: ["ledger-detail", me.email] });
      void qc.invalidateQueries({ queryKey: ["review", me.email] });
      void qc.invalidateQueries({ queryKey: ["receipt-detail", me.email] });
    }
  }, [completed, qc, me.email]);

  const setState = (i: number, s: Partial<UploadState>) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, ...s } : x)));

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);
    const offset = uploads.length;
    setUploads((u) => [...u, ...list.map((f) => ({ name: f.name, state: "preparing" as const }))]);
    // One at a time: keeps memory low on phones and each request well inside the Worker's limits.
    for (const [k, file] of list.entries()) {
      const i = offset + k;
      try {
        const prepared = await prepareFile(file);
        setState(i, { state: "uploading" });
        await uploadReceipt(prepared);
        setState(i, { state: "done" });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          clearSession(qc);
          onSignedOut(SIGN_IN_ERRORS[e.code === "drive_disconnected" || e.code === "not_allowed" ? e.code : "auth_expired"]!);
          return;
        }
        setState(i, { state: "error", message: uploadMessage(e) });
      }
      await qc.invalidateQueries({ queryKey: ["receipts"] });
    }
    if (input.current) input.current.value = "";
  }

  return (
    <main className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="flex min-w-0 flex-col gap-5 lg:col-start-2 lg:row-start-1">
        <ReviewInbox account={me.email} revision={reviewRevision} onSaved={reviewed} />
        <UploadCard me={me} input={input} uploads={uploads} onFiles={(files) => void handleFiles(files)} />
        <RecentReceipts receipts={receipts} />
      </div>
      <div className="min-w-0 lg:col-start-1 lg:row-start-1">
        <LedgerView account={me.email} onReviewed={reviewed} />
      </div>
    </main>
  );
}

const ACCEPT = "image/jpeg,image/png,image/heic,image/heif,.heic,.heif,application/pdf";

function UploadCard({ me, input, uploads, onFiles }: {
  me: Me; input: React.RefObject<HTMLInputElement | null>; uploads: UploadState[]; onFiles: (files: FileList | null) => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <section aria-labelledby="upload-heading" className="card">
      <label
        className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed px-4 py-5 text-center text-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-teal-700 ${dragging ? "border-teal-600 bg-teal-50 dark:bg-teal-950" : "border-slate-300 hover:border-teal-600 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles(e.dataTransfer.files); }}
      >
        <UploadIcon />
        <h2 id="upload-heading" className="font-semibold">
          <span className="lg:hidden">Add receipts</span><span className="hidden lg:inline">Drop receipts here</span>
        </h2>
        <span className="muted">JPG, PNG, HEIC or PDF · <span className="text-teal-700 underline underline-offset-4 dark:text-teal-400">choose files</span></span>
        <input ref={input} type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => onFiles(e.target.files)} />
      </label>
      {uploads.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
          {uploads.map((u, i) => (
            <li key={i} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 truncate">{u.name}</span>
              <span className={u.state === "error" ? "pill pill-red" : u.state === "done" ? "pill pill-teal" : "pill pill-blue"}>
                {u.state === "error" ? u.message : u.state === "done" ? "Saved" : u.state === "uploading" ? "Uploading…" : "Preparing…"}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs">
        {me.driveFolderLink ? <a href={me.driveFolderLink} target="_blank" rel="noreferrer" className="link">Open Drive folder</a>
          : <span className="muted">Files go to “Expense Receipts” in your Drive.</span>}
      </p>
    </section>
  );
}

const RECENT_COUNT = 4;

function RecentReceipts({ receipts }: { receipts: UseQueryResult<ReceiptListItem[]> }) {
  const [expanded, setExpanded] = useState(false);
  const data = receipts.data;
  const working = data?.filter(isWorking).length ?? 0;
  const waiting = data?.filter((r) => r.status === "queued" && r.retryAfter).length ?? 0;
  const failed = data?.filter((r) => r.status === "failed").length ?? 0;
  const summary = [working && `${working} reading`, waiting && `${waiting} waiting`, failed && `${failed} failed`].filter(Boolean).join(" · ");
  const shown = expanded ? data : data?.slice(0, RECENT_COUNT);
  return (
    <section aria-labelledby="receipts-heading" className="card">
      <div className="card-title">
        <h2 id="receipts-heading">Recent receipts</h2>
        {summary && <span className="muted text-xs font-normal">{summary}</span>}
      </div>
      {receipts.isError && data && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">Couldn't refresh receipts. Showing the last known status. <button className="underline" onClick={() => void receipts.refetch()}>Retry</button></p>}
      {receipts.isPending ? (
        <p className="muted mt-2 text-sm">Loading…</p>
      ) : !data ? (
        <p className="mt-2 text-sm text-red-600">Couldn't load receipts.</p>
      ) : data.length === 0 ? (
        <p className="muted mt-2 text-sm">No receipts yet.</p>
      ) : (
        <>
          <ul className={`mt-2 divide-y divide-slate-200 dark:divide-slate-800 ${expanded ? "" : "max-lg:hidden"}`}>
            {shown!.map((r) => <ReceiptRow key={r.id} r={r} />)}
          </ul>
          {(data.length > RECENT_COUNT || !expanded) && (
            <button className={`link mt-2 block w-full text-center text-sm ${data.length > RECENT_COUNT ? "" : "lg:hidden"}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show fewer" : <><span className="lg:hidden">Show receipts</span><span className="hidden lg:inline">Show all {data.length}</span></>}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function UploadIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-6 text-teal-700 dark:text-teal-400"><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M12 4v12M7 9l5-5 5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

const POLL_MS = 3000;
const POLL_CAP_MS = 15 * 60 * 1000;

/** Queued or processing, and not parked until tomorrow. */
const isWorking = (r: Receipt) => (r.status === "queued" && !r.retryAfter) || r.status === "processing";

const STATUS_LABEL: Record<Receipt["status"], string> = {
  uploading: "Uploading",
  queued: "Waiting for extraction",
  processing: "Reading…",
  done: "Done",
  needs_review: "Needs review",
  failed: "Failed",
};

const FAILURE_DETAIL: Record<string, string> = {
  unsupported_scanned_pdf: "Scanned PDF: upload a photo or screenshot instead",
  pdf_conversion_failed: "Couldn't read this PDF",
  drive_file_missing: "The file was removed from Drive: upload it again",
  file_too_large: "The file in Drive is now over 10 MB",
  drive_disconnected: "Google Drive was disconnected",
  processing_timeout: "Took too long to read",
};

/** Permanent failures only; drive_disconnected can be retried after signing in again. */
const NO_RETRY = new Set(["unsupported_scanned_pdf", "drive_file_missing"]);

function statusText(r: ReceiptListItem): { label: string; detail?: string } {
  const after = r.retryAfter && new Date(r.retryAfter).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  if (r.status === "queued" && after) {
    return r.error === "ai_quota"
      ? { label: "Waiting", detail: `Waiting for tomorrow's AI quota (after ${after})` }
      : { label: "Waiting", detail: `Will be sent for extraction after ${after}` };
  }
  if (r.status === "queued" && r.error) return { label: "Retrying soon" };
  if (r.status === "needs_review" && r.error === "invalid_output") return { label: "Needs review", detail: "Some fields couldn't be read" };
  if (r.status === "failed") return { label: "Failed", detail: (r.error && FAILURE_DETAIL[r.error]) ?? "Couldn't be read" };
  if (r.status === "done" && r.hasLedgerEntry === false) return { label: "No ledger entry" };
  return { label: STATUS_LABEL[r.status] };
}

function ReceiptRow({ r }: { r: ReceiptListItem }) {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => retryReceipt(r.id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["receipts"] }),
  });
  const when = new Date(r.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const type = r.mimeType === "application/pdf" ? "PDF" : "Image";
  const { label, detail } = statusText(r);
  const canRetry = r.status === "failed" && !!r.driveLink && !(r.error && NO_RETRY.has(r.error));
  const retryError =
    retry.error instanceof ApiError && retry.error.code === "reupload_required" ? "Upload the file again" : retry.error ? "Retry failed" : null;
  return (
    <li className="py-2.5 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div>{when}</div>
          <div className="muted text-xs">{detail ?? `${type} · ${Math.max(1, Math.round(r.sizeBytes / 1024))} KB`}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={STATUS_PILL[tone(r)]}>{label}</span>
          {r.driveLink && <div className="flex items-center gap-3">
            {canRetry && <button onClick={() => retry.mutate()} disabled={retry.isPending} className="btn">Retry</button>}
            <a href={r.driveLink} target="_blank" rel="noreferrer" className="link inline-flex min-h-11 items-center text-xs sm:min-h-0">View</a>
          </div>}
        </div>
      </div>
      {retryError && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{retryError}</p>}
    </li>
  );
}

const STATUS_PILL = { working: "pill pill-blue", waiting: "pill pill-slate", done: "pill pill-teal", review: "pill pill-amber", failed: "pill pill-red" };

function tone(r: ReceiptListItem): keyof typeof STATUS_PILL {
  if (r.status === "failed") return "failed";
  if (r.status === "needs_review") return "review";
  if (r.status === "done") return r.hasLedgerEntry === false ? "waiting" : "done";
  return r.status === "queued" && r.retryAfter ? "waiting" : "working";
}

function uploadMessage(e: unknown): string {
  if (e instanceof PrepareError) return e.message;
  if (e instanceof ApiError) {
    switch (e.code) {
      case "duplicate_receipt":
        return "Already uploaded";
      case "file_too_large":
        return "Too large (5 MB max for now)";
      case "unsupported_type":
        return "Unsupported file type";
      case "drive_unavailable":
        return "Google Drive is busy; try again";
      default:
        return "Upload failed; try again";
    }
  }
  return "Upload failed; try again";
}
