// Magic-byte checks for the upload allow-list. Never trust the client's Content-Type.
export type AllowedMime = "image/jpeg" | "image/png" | "application/pdf";

export function sniffMime(bytes: Uint8Array): AllowedMime | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png";
  if (b.length >= 5 && [0x25, 0x50, 0x44, 0x46, 0x2d].every((v, i) => b[i] === v)) return "application/pdf"; // %PDF-
  return null;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
