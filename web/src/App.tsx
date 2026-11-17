import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, getMe, listReceipts, logout, retryReceipt, uploadReceipt, type Me, type Receipt } from "./api";
import { prepareFile, PrepareError } from "./prepare";
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
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4 py-6">
      <header className="mb-8 flex items-center gap-3">
        <img src="/logo.svg" alt="" className="size-9" />
        <h1 className="text-lg font-semibold">Expense Tracker</h1>
        {me.data && <Account me={me.data} />}
      </header>

      {notice && (
        <p role="alert" className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
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
  );
}

function SignIn() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <p className="max-w-sm text-slate-600 dark:text-slate-400">Upload receipts; they're saved to your Google Drive and added to your ledger.</p>
      <a
        href="/auth/google"
        className="rounded-lg bg-teal-700 px-5 py-2.5 font-medium text-white shadow-sm hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
      >
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
      <span className="hidden text-slate-600 sm:inline dark:text-slate-400">{me.name ?? me.email}</span>
      <button onClick={() => out.mutate()} disabled={out.isPending} className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800">
        Sign out
      </button>
    </div>
  );
}

type UploadState = { name: string; state: "preparing" | "uploading" | "done" | "error"; message?: string };

function Home({ me, onSignedOut }: { me: Me; onSignedOut: (msg: string) => void }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
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
    <main className="flex flex-col gap-8">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="mb-1 font-medium">Add receipts</h2>
        <p className="mb-4 text-sm text-slate-600 dark:text-slate-400">
          JPG, PNG, HEIC or PDF.{" "}
          {me.driveFolderLink ? (
            <a href={me.driveFolderLink} target="_blank" rel="noreferrer" className="text-teal-700 underline dark:text-teal-400">
              Open Drive folder
            </a>
          ) : (
            "Files go to “Expense Receipts” in your Drive."
          )}
        </p>
        <label className="inline-flex cursor-pointer items-center rounded-lg bg-teal-700 px-4 py-2 font-medium text-white hover:bg-teal-800 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-teal-700">
          Choose files
          <input
            ref={input}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif,application/pdf"
            className="sr-only"
            onChange={(e) => void handleFiles(e.target.files)}
          />
        </label>
        {uploads.length > 0 && (
          <ul className="mt-4 space-y-1 text-sm">
            {uploads.map((u, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="truncate">{u.name}</span>
                <span className={u.state === "error" ? "text-red-600" : u.state === "done" ? "text-teal-700 dark:text-teal-400" : "text-slate-500"}>
                  {u.state === "error" ? u.message : u.state === "done" ? "Saved" : u.state === "uploading" ? "Uploading…" : "Preparing…"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <LedgerView account={me.email} />

      <section>
        <h2 className="mb-3 font-medium">Recent receipts</h2>
        {receipts.isPending ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : receipts.isError ? (
          <p className="text-sm text-red-600">Couldn't load receipts.</p>
        ) : receipts.data.length === 0 ? (
          <p className="text-sm text-slate-500">No receipts yet.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {receipts.data.map((r) => (
              <ReceiptRow key={r.id} r={r} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
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
  drive_disconnected: "Google Drive was disconnected",
  processing_timeout: "Took too long to read",
};

/** Permanent failures only; drive_disconnected can be retried after signing in again. */
const NO_RETRY = new Set(["unsupported_scanned_pdf", "drive_file_missing"]);

function statusText(r: Receipt): { label: string; detail?: string } {
  const after = r.retryAfter && new Date(r.retryAfter).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  if (r.status === "queued" && after) {
    return r.error === "ai_quota"
      ? { label: "Waiting", detail: `Waiting for tomorrow's AI quota (after ${after})` }
      : { label: "Waiting", detail: `Will be sent for extraction after ${after}` };
  }
  if (r.status === "queued" && r.error) return { label: "Retrying soon" };
  if (r.status === "needs_review" && r.error === "invalid_output") return { label: "Needs review", detail: "Some fields couldn't be read" };
  if (r.status === "failed") return { label: "Failed", detail: (r.error && FAILURE_DETAIL[r.error]) ?? "Couldn't be read" };
  return { label: STATUS_LABEL[r.status] };
}

function ReceiptRow({ r }: { r: Receipt }) {
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
    <li className="flex items-center gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div>{when}</div>
        <div className="text-slate-500">
          {type} · {Math.max(1, Math.round(r.sizeBytes / 1024))} KB
        </div>
      </div>
      <div className="text-right">
        <div className={r.status === "failed" ? "text-red-600" : r.status === "needs_review" ? "text-amber-700 dark:text-amber-400" : "text-slate-600 dark:text-slate-400"}>
          {label}
        </div>
        {(retryError ?? detail) && <div className="text-xs text-slate-500">{retryError ?? detail}</div>}
      </div>
      {canRetry && (
        <button
          onClick={() => retry.mutate()}
          disabled={retry.isPending}
          className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Retry
        </button>
      )}
      {r.driveLink && (
        <a href={r.driveLink} target="_blank" rel="noreferrer" className="text-teal-700 underline dark:text-teal-400">
          View
        </a>
      )}
    </li>
  );
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
