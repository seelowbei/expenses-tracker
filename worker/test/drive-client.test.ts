import { describe, expect, it } from "vitest";
import { DriveError, driveApi } from "../src/drive/client";
import { downloadUrl, fakeGoogle } from "./helpers";

describe("downloadFile", () => {
  it("reads the file bytes with alt=media and the bearer token", async () => {
    const google = fakeGoogle({ [downloadUrl("f%201")]: () => new Response(new Uint8Array([9, 8, 7])) });
    const bytes = await driveApi("at-1", google.fetch).downloadFile("f 1");
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
    const err = await driveApi("at", google.fetch).downloadFile("f").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect((err as DriveError).kind).toBe(kind);
  });
});
