// Browser-side file preparation (spec "Key flows" 2.1): type/size checks, HEIC -> JPEG,
// resize to a 2000 px long edge at ~80% JPEG quality. The Worker never transforms images.

export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
/** Direct upload limit until the resumable flow exists (M5). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_EDGE = 2000;
const JPEG_QUALITY = 0.8;

export class PrepareError extends Error {}

type Kind = "jpeg" | "png" | "pdf" | "heic";

async function sniff(file: File): Promise<Kind | null> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (String.fromCharCode(...b.slice(0, 5)) === "%PDF-") return "pdf";
  // ISO-BMFF: "ftyp" at offset 4, then a HEIF brand.
  if (String.fromCharCode(...b.slice(4, 8)) === "ftyp") {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic";
  }
  return null;
}

async function decode(file: File, kind: Kind): Promise<ImageBitmap> {
  if (kind === "heic") {
    // ~3 MB (libheif wasm): loaded only when a HEIC file is picked.
    const { heicTo } = await import("heic-to");
    return heicTo({ blob: file, type: "bitmap" });
  }
  return createImageBitmap(file, { imageOrientation: "from-image" });
}

function toJpeg(bitmap: ImageBitmap): Promise<Blob> {
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new PrepareError("This browser can't process images.");
  ctx.fillStyle = "#fff"; // PNG transparency becomes white, not black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new PrepareError("Couldn't convert the image."))), "image/jpeg", JPEG_QUALITY),
  );
}

export async function prepareFile(file: File): Promise<File> {
  if (file.size > MAX_INPUT_BYTES) throw new PrepareError("Files over 10 MB aren't supported.");
  const kind = await sniff(file);
  if (!kind) throw new PrepareError("Use a JPG, PNG, HEIC or PDF file.");

  if (kind === "pdf") {
    if (file.size > MAX_UPLOAD_BYTES) throw new PrepareError("PDFs over 5 MB aren't supported yet.");
    return file;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await decode(file, kind);
  } catch {
    throw new PrepareError("Couldn't read this image.");
  }
  const jpeg = await toJpeg(bitmap);
  if (jpeg.size > MAX_UPLOAD_BYTES) throw new PrepareError("The image is still over 5 MB after resizing.");
  const base = file.name.replace(/\.[^.]+$/, "") || "receipt";
  return new File([jpeg], `${base}.jpg`, { type: "image/jpeg" });
}
