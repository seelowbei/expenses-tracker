import { describe, expect, it } from "vitest";
import { DriveError, DriveFileTooLargeError, driveApi } from "../src/drive/client";
import { downloadUrl, fakeGoogle } from "./helpers";

describe("downloadFile", () => {
  it("reads the file bytes with alt=media and the bearer token", async () => {
    const google = fakeGoogle({ [downloadUrl("f%201")]: () => new Response(new Uint8Array([9, 8, 7])) });
    const bytes = await driveApi("at-1", google.fetch).downloadFile("f 1", 1024);
    expect([...bytes]).toEqual([9, 8, 7]);
    const call = google.calls[0]!;
    expect(call.url.searchParams.get("alt")).toBe("media");
    expect(call.url.href).toContain("/files/f%201?");
    expect(call.headers.get("Authorization")).toBe("Bearer at-1");
  });

  it.each([
    [404, "not_found"],
    [401, "unauthorized"],
    [429, "unavailable"],
    [503, "unavailable"],
    [403, "other"],
  ] as const)("maps HTTP %i to %s", async (status, kind) => {
    const google = fakeGoogle({ [downloadUrl("f")]: () => new Response("x", { status }) });
    const err = await driveApi("at", google.fetch).downloadFile("f", 1024).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect((err as DriveError).kind).toBe(kind);
  });

  it("rejects a file whose Content-Length is over the limit without reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } });
    const google = fakeGoogle({ [downloadUrl("f")]: () => new Response(body, { headers: { "Content-Length": "11" } }) });
    const err = await driveApi("at", google.fetch).downloadFile("f", 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriveFileTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("stops reading once the streamed bytes pass the limit when Content-Length is absent", async () => {
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { chunks++; c.enqueue(new Uint8Array(4)); } }); // endless
    const google = fakeGoogle({ [downloadUrl("f")]: () => new Response(body) });
    const err = await driveApi("at", google.fetch).downloadFile("f", 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriveFileTooLargeError);
    expect(chunks).toBeLessThan(10);
  });

  it("joins streamed chunks up to the limit", async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } });
    const google = fakeGoogle({ [downloadUrl("f")]: () => new Response(body) });
    expect([...await driveApi("at", google.fetch).downloadFile("f", 3)]).toEqual([1, 2, 3]);
  });
});
