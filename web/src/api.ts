import type { ReviewCreate, ReviewDetail, ReceiptPage } from "../../worker/src/contracts/review";
// Typed calls to the Worker API. Same origin, so the session cookie and Origin header come for free.
import { ApiError } from "./api-error";
export { ApiError } from "./api-error";
import type { CategoryDto } from "../../worker/src/contracts/categories";
import type { LedgerDetail, LedgerFilters, LedgerPage } from "../../worker/src/contracts/ledger";
import type { LedgerPatch } from "../../worker/src/contracts/ledger-write";
export type { LedgerSummary, LedgerTotal } from "../../worker/src/contracts/ledger";

export interface Me {
  name: string | null;
  email: string;
  defaultCurrency: string;
  driveStatus: "connected" | "disconnected";
  driveFolderLink: string | null;
}

export type ReceiptStatus = "uploading" | "queued" | "processing" | "done" | "needs_review" | "failed";

export interface Receipt {
  id: string;
  status: ReceiptStatus;
  mimeType: string;
  sizeBytes: number;
  driveLink: string | null;
  error: string | null;
  /** Set while parked (AI quota or queue unavailable); the daily cron sends it again after this time. */
  retryAfter: string | null;
  reviewReasons: string[] | null;
  createdAt: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, typeof body.error === "string" ? body.error : `http_${res.status}`, body);
  return body as T;
}

/** null when signed out. */
export async function getMe(): Promise<Me | null> {
  try {
    return await call<Me>("/api/me");
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export const listReceipts = (signal?: AbortSignal) => call<{ receipts: Receipt[] }>("/api/receipts", { signal }).then((r) => r.receipts);

export const listCategories = (signal?: AbortSignal) =>
  call<{ categories: CategoryDto[] }>("/api/categories", { signal }).then((r) => r.categories);

export function listLedger(filters: LedgerFilters, cursor?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.category) query.set("category", filters.category);
  if (cursor) query.set("cursor", cursor);
  return call<LedgerPage>(`/api/ledger?${query}`, { signal });
}

export const getLedgerEntry = (id: string, signal?: AbortSignal) =>
  call<{ entry: LedgerDetail }>(`/api/ledger/${encodeURIComponent(id)}`, { signal }).then((r) => r.entry);

export function uploadReceipt(file: File): Promise<{ receipt: Receipt }> {
  const form = new FormData();
  form.append("file", file);
  return call("/api/receipts", { method: "POST", body: form });
}

export const retryReceipt = (id: string) =>
  call<{ receipt: Receipt }>(`/api/receipts/${encodeURIComponent(id)}/retry`, { method: "POST" });

export const logout = () => call<void>("/auth/logout", { method: "POST" });

export const patchLedgerEntry = (id: string, patch: LedgerPatch, signal?: AbortSignal) =>
  call<{ entry: LedgerDetail }>(`/api/ledger/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch), signal,
  }).then((r) => r.entry);

export async function getReceiptFile(id: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(`/api/receipts/${encodeURIComponent(id)}/file`, { credentials: "same-origin", cache: "no-store", signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new ApiError(res.status, typeof body.error === "string" ? body.error : `http_${res.status}`);
  }
  if (!["image/jpeg", "image/png", "application/pdf"].includes(res.headers.get("Content-Type") ?? "")) throw new ApiError(415, "unsupported_type");
  return res.blob();
}

export const getReceiptDetail = (id: string, signal?: AbortSignal) =>
  call<ReviewDetail>(`/api/receipts/${encodeURIComponent(id)}`, { signal });
export const createReceiptReview = (id: string, body: ReviewCreate, signal?: AbortSignal) =>
  call<{ entry: LedgerDetail }>(`/api/receipts/${encodeURIComponent(id)}/review`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  }).then((result) => result.entry);
export const listReviewReceipts = (cursor?: string, signal?: AbortSignal) => {
  const query = new URLSearchParams({ status: "needs_review" });
  if (cursor) query.set("cursor", cursor);
  return call<ReceiptPage>(`/api/receipts?${query}`, { signal });
};
