import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";
import { createElectronTestEnv } from "./harness.js";

const env = createElectronTestEnv({
  prefix: "attachment-store-", paths: ["chatStorage", "localChatDb", "localProfile"],
  extraCleanupEnvKeys: ["LETAGENTS_DESKTOP_USER_DATA_DIR"],
});
process.env.LETAGENTS_DESKTOP_USER_DATA_DIR = env.tempDir;
mock.module("electron", { defaultExport: { app: { getPath: () => env.tempDir } } });

const {
  MESSAGE_ATTACHMENT_LIMITS,
  parseMessageAttachmentUploadTarget,
  stageCloudMessageAttachment,
} = await import("../../../../shared/message-attachments.mjs");
const {
  handleAttachmentProtocolRequest,
  mapRoomMessageAttachmentPayload,
  resolveAttachmentStore,
  stageDroppedDesktopAttachmentContents,
} = await import("../main/attachments.js");
const { attachmentFile } = await import("../main/attachments/store.js");
const { sendDesktopRoomMessage } = await import("../main/rooms/messages.js");
const { localFilesPath, setChatStorageMode } = await import("../main/chat-storage/settings.js");
const { addLocalChatMessage, getLocalChatMessages } = await import("../main/rooms/messages/local-store.js");
const { readLocalAttachmentBytes } = await import("../main/attachments/local-store.js");

const PNG_BASE64 = Buffer.from("\x89PNG\r\n\x1a\nfake image bytes", "latin1").toString("base64");

test("the upload slot is read strictly, with no guessed field names", () => {
  assert.deepEqual(
    parseMessageAttachmentUploadTarget({ upload_id: "upl_1", upload_url: "https://store.test/put", method: "PUT", headers: { "Content-Type": "image/png", bad: 1 } }),
    { uploadId: "upl_1", uploadUrl: "https://store.test/put", headers: { "Content-Type": "image/png" } },
  );
  assert.throws(() => parseMessageAttachmentUploadTarget({ attachment: { upload_id: "upl_1" }, url: "https://store.test/put" }), /incomplete/);
  assert.throws(() => parseMessageAttachmentUploadTarget({ upload_id: "upl_1", upload_url: "https://store.test/put", method: "POST", fields: {} }), /incomplete/);
});

test("cloud staging posts the canonical fields, puts the bytes, and discards a failed upload", async () => {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const puts: Array<{ url: string; contentType: string | null; size: number }> = [];
  let putStatus = 200;
  const transport = {
    requestJson: async (path: string, init: { method: string; body?: string }) => {
      calls.push({ path, method: init.method, body: init.body });
      return init.method === "POST" ? { upload_id: "upl_7", upload_url: "https://store.test/put", method: "PUT", headers: { "Content-Type": "image/png" } } : { ok: true };
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      puts.push({ url: String(url), contentType: new Headers(init?.headers).get("content-type"), size: (init?.body as Uint8Array).byteLength });
      return new Response(null, { status: putStatus });
    }) as typeof fetch,
  };
  const bytes = Buffer.from("abc");

  const staged = await stageCloudMessageAttachment(transport, { roomPath: "/rooms/r1", fileName: "a.png", mimeType: "image/png", bytes });
  assert.deepEqual(staged, { uploadId: "upl_7", fileName: "a.png", mimeType: "image/png", sizeBytes: 3 });
  assert.deepEqual(JSON.parse(calls[0]!.body!), { filename: "a.png", content_type: "image/png", byte_size: 3 });
  assert.deepEqual(puts, [{ url: "https://store.test/put", contentType: "image/png", size: 3 }]);

  putStatus = 500;
  await assert.rejects(stageCloudMessageAttachment(transport, { roomPath: "/rooms/r1", fileName: "a.png", mimeType: "image/png", bytes }), /HTTP 500/);
  assert.deepEqual(calls.at(-1), { path: "/rooms/r1/attachments/uploads/upl_7", method: "DELETE", body: undefined });
});

test("every room store refuses a file over the shared size limit before writing it", () => {
  assert.throws(
    () => attachmentFile({ fileName: "big.bin", bytes: Buffer.alloc(MESSAGE_ATTACHMENT_LIMITS.maxFileBytes + 1) }),
    /big\.bin is larger than 25 MB/,
  );
  assert.equal(attachmentFile({ fileName: "photo.webp", bytes: Buffer.from("x") }).mimeType, "image/webp");
});

test("a local room stores an image once and the screen loads it through the attachment protocol", async () => {
  await setChatStorageMode("local");
  const room = "attachment-store-local";
  assert.equal((await resolveAttachmentStore(room)).kind, "local");
  const [draft] = await stageDroppedDesktopAttachmentContents(room, [{ fileName: "shot.png", mimeType: "image/png", sizeBytes: 26, contentBase64: PNG_BASE64 }]);
  assert.match(draft!.previewDataUrl ?? "", /^data:image\/png;base64,/);

  const sent = await sendDesktopRoomMessage(room, "", null, [{ upload_id: draft!.uploadId }], null, "desktop-send:6f2c1b8e-58a1-4b54-9f0b-2b4f0c1f9a01");
  const [shown] = sent.message.attachments;
  assert.equal(shown?.fileName, "shot.png");
  assert.equal(shown?.mimeType, "image/png");
  assert.match(shown?.href ?? "", /^letagents-attachment:\/\/local\//);

  const [stored] = (await getLocalChatMessages(room)).messages.at(-1)!.attachments ?? [];
  assert.equal(stored?.data_url ?? null, null, "no inline copy of the image in the database");
  assert.equal(stored?.content_base64 ?? null, null);
  const roomFiles = await readdir(join(localFilesPath, room));
  assert.equal(roomFiles.length, 1, "exactly one file on disk");

  const served = await handleAttachmentProtocolRequest(new Request(shown!.href!));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await served.arrayBuffer()).toString("base64"), PNG_BASE64);
});

test("the local attachment route serves only files inside the local files folder", async () => {
  const outside = `letagents-attachment://local/${Buffer.from("../../outside.txt").toString("base64url")}`;
  assert.equal((await handleAttachmentProtocolRequest(new Request(outside))).status, 403);
  const missing = `letagents-attachment://local/${Buffer.from("room/missing.png").toString("base64url")}`;
  assert.equal((await handleAttachmentProtocolRequest(new Request(missing))).status, 404);
});

test("older local rows skip their inline copy when they have a file, and keep it when it is the only copy", async () => {
  const room = "attachment-store-legacy";
  const filePath = join(localFilesPath, room, "legacy.png");
  await mkdir(join(localFilesPath, room), { recursive: true });
  await writeFile(filePath, Buffer.from(PNG_BASE64, "base64"));
  await addLocalChatMessage(room, {
    sender: "Human",
    text: "legacy",
    source: "browser",
    attachments: [
      { id: "with-file", file_name: "legacy.png", mime_type: "image/png", url: pathToFileURL(filePath).toString(), data_url: `data:image/png;base64,${PNG_BASE64}` },
      { id: "inline-only", file_name: "inline.png", mime_type: "image/png", data_url: `data:image/png;base64,${PNG_BASE64}` },
    ],
  });
  const stored = (await getLocalChatMessages(room)).messages.at(-1)!.attachments ?? [];
  const byId = new Map(stored.map((attachment) => [attachment.id, attachment]));
  assert.equal(byId.get("with-file")?.data_url ?? null, null);
  assert.equal(byId.get("inline-only")?.data_url, `data:image/png;base64,${PNG_BASE64}`);
  assert.match(mapRoomMessageAttachmentPayload(byId.get("with-file")!).href ?? "", /^letagents-attachment:\/\/local\//);
  assert.equal(mapRoomMessageAttachmentPayload(byId.get("inline-only")!).href, `data:image/png;base64,${PNG_BASE64}`);
});

test("the mapper gives the screen one name, one type and one safe link", () => {
  const cloud = mapRoomMessageAttachmentPayload({ id: "att_1", filename: "plan.pdf", content_type: "application/pdf", byte_size: 9, download_url: "/rooms/r1/messages/msg_1/attachments/att_1" });
  assert.deepEqual(Object.keys(cloud).sort(), ["fileName", "href", "id", "mimeType", "sizeBytes"]);
  assert.equal(cloud.fileName, "plan.pdf");
  assert.equal(cloud.mimeType, "application/pdf");
  assert.equal(
    Buffer.from(new URL(cloud.href!).pathname.slice(1), "base64url").toString("utf8"),
    "/rooms/r1/messages/msg_1/attachments/att_1",
  );
  assert.equal(mapRoomMessageAttachmentPayload({ url: "file:///etc/passwd" }).href, null);
  assert.equal(mapRoomMessageAttachmentPayload({ download_url: "javascript:alert(1)" }).href, null);
  assert.equal(mapRoomMessageAttachmentPayload({}).fileName, "attachment");
});

test("a failed drop stages nothing: files staged earlier in the same call are removed", async () => {
  await setChatStorageMode("local");
  const room = "attachment-store-all-or-nothing";
  const big = Buffer.alloc(MESSAGE_ATTACHMENT_LIMITS.maxFileBytes + 1).toString("base64");
  await assert.rejects(stageDroppedDesktopAttachmentContents(room, [
    { fileName: "small.png", mimeType: "image/png", sizeBytes: 26, contentBase64: PNG_BASE64 },
    { fileName: "big.bin", mimeType: "application/octet-stream", sizeBytes: MESSAGE_ATTACHMENT_LIMITS.maxFileBytes + 1, contentBase64: big },
  ]), /big\.bin is larger than 25 MB/);
  assert.deepEqual(await readdir(join(localFilesPath, room)).catch(() => []), []);
});

test("a symlink inside the local files folder cannot reach a file outside it", async () => {
  const room = "attachment-store-symlink";
  const outside = join(env.tempDir, "outside-secret.txt");
  await writeFile(outside, "secret");
  await mkdir(join(localFilesPath, room), { recursive: true });
  const link = join(localFilesPath, room, "link.png");
  await symlink(outside, link);
  const href = mapRoomMessageAttachmentPayload({ url: pathToFileURL(link).toString(), mime_type: "image/png" }).href!;
  assert.equal((await handleAttachmentProtocolRequest(new Request(href))).status, 403);
  await assert.rejects(readLocalAttachmentBytes({ url: pathToFileURL(link).toString() }), /outside the local files folder/);
  await assert.rejects(readLocalAttachmentBytes({ url: pathToFileURL(outside).toString() }), /outside the local files folder/);
});

test("a local SVG is served as an image that cannot run script", async () => {
  const room = "attachment-store-svg";
  await mkdir(join(localFilesPath, room), { recursive: true });
  const filePath = join(localFilesPath, room, "diagram.svg");
  await writeFile(filePath, "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const served = await handleAttachmentProtocolRequest(new Request(mapRoomMessageAttachmentPayload({ url: pathToFileURL(filePath).toString() }).href!));
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/svg+xml");
  assert.match(served.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
});

test("the cloud proxy sends the sign-in only to attachment downloads and adds safety headers", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("<svg onload=alert(1)>", {
      headers: { "Content-Type": "image/svg+xml", "Content-Encoding": "gzip", "Content-Length": "999" },
    });
  }) as typeof fetch;
  const href = (path: string) => `letagents-attachment://download/${Buffer.from(path, "utf8").toString("base64url")}`;
  try {
    const served = await handleAttachmentProtocolRequest(new Request(href("/rooms/github.com%2Fo%2Fr/messages/msg_1/attachments/att_1")));
    assert.equal(served.status, 200);
    assert.match(served.headers.get("content-security-policy") ?? "", /default-src 'none'.*sandbox/);
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.equal(served.headers.get("content-encoding"), null);
    assert.equal(served.headers.get("content-type"), "image/svg+xml");
    assert.equal(await served.text(), "<svg onload=alert(1)>");

    assert.equal((await handleAttachmentProtocolRequest(new Request(href("/projects/p_1/messages/msg_1/attachments/att_1")))).status, 200);
    assert.equal((await handleAttachmentProtocolRequest(new Request(href("/auth/session")))).status, 403);
    assert.equal((await handleAttachmentProtocolRequest(new Request(href("/auth/x/rooms/r/messages/m/attachments/a")))).status, 403);
    assert.equal((await handleAttachmentProtocolRequest(new Request(href("/rooms/x/messages")))).status, 403);
    assert.equal((await handleAttachmentProtocolRequest(new Request(href("/rooms/x/messages/m/attachments/a/extra")))).status, 403);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
