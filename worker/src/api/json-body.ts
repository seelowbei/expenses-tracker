export async function readJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; error: string; status: 400 | 413 }> {
  // Count actual streamed bytes; Content-Length may be absent or misleading.
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 32 * 1024) { await reader.cancel(); return { ok: false, error: "body_too_large", status: 413 }; }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch { return { ok: false, error: "invalid_body", status: 400 }; }
    finally { reader.releaseLock(); }
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { return { ok: false, error: "invalid_json", status: 400 }; }
  return { ok: true, body };
}
