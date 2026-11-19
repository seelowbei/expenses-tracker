// Minimal Google Drive v3 client (drive.file scope): create folder, multipart upload, download.
import type { Fetcher } from "../app-env";

const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
export const FOLDER_NAME = "Expense Receipts";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** HTTP-level Drive failure. `kind` drives retry/disconnect handling; nothing here holds file content. */
export class DriveError extends Error {
  constructor(
    readonly status: number,
    readonly kind: "unauthorized" | "not_found" | "unavailable" | "other",
  ) {
    super(`drive_${kind}_${status}`);
  }
}

function classify(status: number): DriveError["kind"] {
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429 || status >= 500) return "unavailable";
  // Drive reports per-user rate limits as 403 with reason userRateLimitExceeded; treat 403 as "other"
  // except in callers that know better. Keep it simple until real traffic says otherwise.
  return "other";
}

/** The Drive file is larger than the caller's limit (e.g. the user replaced it with a bigger version). */
export class DriveFileTooLargeError extends Error {
  readonly code = "file_too_large";
}

async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  await res.body?.cancel();
  throw new DriveError(res.status, classify(res.status));
}

export interface DriveApi {
  createFolder(name?: string): Promise<string>;
  uploadMultipart(file: { name: string; mimeType: string; parentId: string; body: Blob }): Promise<{ id: string; webViewLink: string }>;
  /**
   * Read-only `files.get?alt=media`, buffered. 404 when the user deleted the file (or it isn't ours).
   * Throws DriveFileTooLargeError past `maxBytes`, checked on Content-Length and on the streamed bytes.
   */
  downloadFile(fileId: string, maxBytes: number): Promise<Uint8Array>;
  /** Original response body for streaming previews; caller owns consuming/cancelling it. */
  openFile(fileId: string): Promise<Response>;
}

export function driveApi(accessToken: string, fetcher: Fetcher): DriveApi {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const openFile = (fileId: string) => fetcher(`${FILES_URL}/${encodeURIComponent(fileId)}?alt=media`, { method: "GET", headers: auth }).then(ensureOk);
  return {
    async createFolder(name = FOLDER_NAME) {
      const res = await ensureOk(
        await fetcher(`${FILES_URL}?fields=id`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
        }),
      );
      const { id } = (await res.json()) as { id: string };
      return id;
    },

    async uploadMultipart({ name, mimeType, parentId, body }) {
      const boundary = `receipt-${crypto.randomUUID()}`;
      const metadata = JSON.stringify({ name, mimeType, parents: [parentId] });
      // A Blob of parts: the file bytes are referenced, not copied into a new string/buffer by us.
      const multipart = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
        body,
        `\r\n--${boundary}--\r\n`,
      ]);
      const res = await ensureOk(
        await fetcher(`${UPLOAD_URL}?uploadType=multipart&fields=id,webViewLink`, {
          method: "POST",
          headers: { ...auth, "Content-Type": `multipart/related; boundary=${boundary}` },
          body: multipart,
        }),
      );
      return (await res.json()) as { id: string; webViewLink: string };
    },

    openFile,
    async downloadFile(fileId, maxBytes) {
      const res = await openFile(fileId);
      if (Number(res.headers.get("Content-Length")) > maxBytes) {
        await res.body?.cancel();
        throw new DriveFileTooLargeError();
      }
      if (!res.body) return new Uint8Array();
      // Count streamed bytes too: Content-Length may be absent.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new DriveFileTooLargeError();
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },
  };
}

export const folderLink = (folderId: string) => `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
