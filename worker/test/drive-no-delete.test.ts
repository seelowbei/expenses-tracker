// Guards the "Drive is write-once" rule (spec, "Security & privacy"; AGENTS.md).
// drive.file would let the app delete, trash or overwrite files it created, so the code must not.
import { describe, expect, it } from "vitest";
import { driveApi } from "../src/drive/client";
import { downloadUrl, fakeGoogle, FOLDER_URL, json, UPLOAD_URL } from "./helpers";

// Vite's import.meta.glob, typed here because vite/client types aren't a worker dependency.
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
  }
}

// Every source file, as text (resolved by Vite at build time; workerd has no fs).
const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

describe("Drive is write-once", () => {
  it("the Drive client can only create a folder, upload a new file and read a file", async () => {
    const google = fakeGoogle({
      [FOLDER_URL]: () => json({ id: "folder" }),
      [UPLOAD_URL]: () => json({ id: "file", webViewLink: "https://drive.google.com/file/d/file/view" }),
      [downloadUrl("file")]: () => new Response(new Uint8Array([1, 2, 3])),
    });
    const drive = driveApi("at", google.fetch);
    expect(Object.keys(drive).sort()).toEqual(["createFolder", "downloadFile", "openFile", "uploadMultipart"]);

    await drive.createFolder();
    await drive.uploadMultipart({ name: "r.jpg", mimeType: "image/jpeg", parentId: "folder", body: new Blob(["x"]) });
    await drive.downloadFile("file", 1024);
    await (await drive.openFile("file")).body?.cancel();
    for (const call of google.calls) {
      // POST to the collection = create; GET = read. Any other method on /files/<id> would be an update or delete.
      expect(call.key).toMatch(
        /^(POST https:\/\/www\.googleapis\.com\/(upload\/)?drive\/v3\/files|GET https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[^/]+)$/,
      );
      expect(call.body).not.toMatch(/trashed/i);
    }
  });

  it("no source file calls Drive outside src/drive/client.ts", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.endsWith("/src/drive/client.ts"))
      .filter(([, text]) => /googleapis\.com\/(upload\/)?drive/.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("no source file deletes, trashes or updates Drive files", () => {
    expect(sources["../src/drive/client.ts"]).toBeDefined();
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(sources)) {
      // Trashing is a files.update with { trashed: true }, or files.emptyTrash.
      if (/trash/i.test(text)) offenders.push(`${path}: mentions trash`);
      // Drive delete/update requests. Checked in src/drive/ only: API routes may use DELETE for D1 rows.
      if (path.includes("/src/drive/") && /method:\s*["'](DELETE|PATCH|PUT)["']/.test(text)) offenders.push(`${path}: DELETE/PATCH/PUT`);
    }
    expect(offenders).toEqual([]);
  });
});
