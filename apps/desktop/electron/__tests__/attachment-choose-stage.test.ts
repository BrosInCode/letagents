import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

test("choosing files reads them without uploading; staging uploads them all at once, each choice once", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = await mkdtemp(join(tmpdir(), "letagents-attach-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const paths = [join(folder, "a.png"), join(folder, "b.txt")];
  await writeFile(paths[0]!, Buffer.from([1, 2, 3]));
  await writeFile(paths[1]!, "hello");

  let uploading = 0;
  let mostAtOnce = 0;
  const requests: string[] = [];
  t.mock.module("electron", { defaultExport: { dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: paths }) } } });
  t.mock.module("../main/window.js", { namedExports: { focusMainWindow() {}, getMainWindow: () => null } });
  t.mock.module("../main/auth.js", { namedExports: {
    apiFetch: async (path: string, init: { body: string }) => {
      requests.push(path);
      uploading += 1;
      mostAtOnce = Math.max(mostAtOnce, uploading);
      await new Promise(resolve => setTimeout(resolve, 10));
      uploading -= 1;
      const { filename } = JSON.parse(init.body) as { filename: string };
      return { upload_id: `up-${filename}`, upload_url: "https://storage.invalid/put", method: "PUT", headers: {} };
    },
    readStoredAuth: async () => null,
  } });
  t.mock.module("../main/chat-storage/settings.js", { namedExports: { localFilesPath: () => "/unused" } });
  t.mock.module("../main/rooms/local-store.js", { namedExports: {
    resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: "cloud" }),
    cloudRoomIdentifierForStorage: (_storage: unknown, identifier: string) => identifier,
    localRoomIdentifierForStorage: (_storage: unknown, identifier: string) => identifier,
  } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const { chooseDesktopAttachmentFiles, stageChosenDesktopAttachments } = await import("../main/attachments.js");
  const chosen = await chooseDesktopAttachmentFiles();
  assert.deepEqual(requests, [], "choosing uploads nothing");
  assert.deepEqual(chosen.map((file) => [file.fileName, file.mimeType, file.sizeBytes]), [["a.png", "image/png", 3], ["b.txt", "text/plain", 5]]);
  assert.match(chosen[0]!.previewDataUrl ?? "", /^data:image\/png;base64,/);
  assert.equal(chosen[1]!.previewDataUrl, null);

  const staged = await stageChosenDesktopAttachments("room_1", chosen.map((file) => file.token));
  assert.deepEqual(staged.map((file) => file.uploadId), ["up-a.png", "up-b.txt"], "results keep the chosen order");
  assert.deepEqual(staged.map((file) => file.previewDataUrl), [null, null], "previews cross IPC once, at choose time");
  assert.equal(mostAtOnce, 2, "both uploads start together");
  await assert.rejects(stageChosenDesktopAttachments("room_1", [chosen[0]!.token]), /Choose them again/);

  // Only as many files as the composer has room for are read.
  assert.deepEqual((await chooseDesktopAttachmentFiles(1)).map((file) => file.fileName), ["a.png"]);
  assert.deepEqual(await chooseDesktopAttachmentFiles(0), []);
});
