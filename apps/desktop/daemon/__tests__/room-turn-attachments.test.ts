import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { attachmentStorageUrl, downloadRoomAttachment, isThisMachineAddress, readRoomThread, storageResolvesToThisMachine } from "../cloud-http.js";
import {
  activatingThreadRootId,
  declaredRoomAttachments,
  roomTurnFileKey,
  recentRoomImageMessages,
  rememberedRoomTurnFiles,
  RoomAttachmentDownloadError,
  RoomTurnAttachmentStager,
  ROOM_TURN_IMAGE_MAX_BYTES,
  ROOM_TURN_RECENT_IMAGES_MAX_BYTES,
  sniffRoomTurnImageType,
  STAGED_FOLDER_MAX_AGE_MS,
} from "../room-turn-attachments.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = new TextEncoder().encode("GIF89a\u0001\u0000\u0001\u0000");
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38]);

type Download = { messageId: string; attachmentId: string; bearer: string; maxBytes: number };

function attachment(id: string, overrides: Record<string, unknown> = {}) {
  return { id, filename: `${id}.png`, content_type: "image/png", byte_size: PNG.byteLength,
    download_url: `/rooms/room_1/messages/msg_7/attachments/${id}`, ...overrides };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "room-turn-attachments-"));
  try { await run(join(parent, "room-turn-attachments")); } finally { await rm(parent, { recursive: true, force: true }); }
}

function prepareInput(overrides: Record<string, unknown>, downloads: Download[] = [], bytes: (id: string) => Uint8Array | Error = () => PNG) {
  return {
    delivery: "memory" as const,
    localRoom: false,
    sourceMessage: { id: "msg_7", text: "Look", attachments: [attachment("att_1")] },
    sourceMessageId: "msg_7",
    roomId: "room_1",
    apiUrl: "https://api.example.test",
    bearer: "worker-bearer",
    http: {
      async downloadAttachment(input: Download & { signal: AbortSignal }) {
        downloads.push({ messageId: input.messageId, attachmentId: input.attachmentId, bearer: input.bearer, maxBytes: input.maxBytes });
        const result = bytes(input.attachmentId);
        if (result instanceof Error) throw result;
        return result;
      },
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("image types come from the bytes, not from the declared type", () => {
  assert.equal(sniffRoomTurnImageType(PNG), "image/png");
  assert.equal(sniffRoomTurnImageType(JPEG), "image/jpeg");
  assert.equal(sniffRoomTurnImageType(GIF), "image/gif");
  assert.equal(sniffRoomTurnImageType(WEBP), "image/webp");
  assert.equal(sniffRoomTurnImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(sniffRoomTurnImageType(new TextEncoder().encode("RIFF....WAVEfmt ")), null);
  assert.equal(sniffRoomTurnImageType(new Uint8Array()), null);
});

test("attachments are read under either server field name, and file names stay printable", () => {
  assert.deepEqual(declaredRoomAttachments({ attachments: [
    { id: "att_1", file_name: "shot\u0000 .PNG", mime_type: "IMAGE/PNG", size_bytes: 12 },
    { id: "att_2", filename: "", content_type: "application/pdf" },
    "not an attachment",
  ] }), [
    { index: 1, id: "att_1", fileName: "shot.PNG", mimeType: "image/png", sizeBytes: 12 },
    { index: 2, id: "att_2", fileName: "attachment 2", mimeType: "application/pdf", sizeBytes: null },
  ]);
  assert.deepEqual(declaredRoomAttachments({ id: "msg_1", text: "no files" }), []);
  assert.deepEqual(declaredRoomAttachments(null), []);
});

test("a message without attachments prepares nothing and downloads nothing", async () => {
  await withRoot(async (root) => {
    const downloads: Download[] = [];
    const prepared = await new RoomTurnAttachmentStager(root).prepare(prepareInput({ sourceMessage: { id: "msg_7", text: "hi" } }, downloads));
    assert.deepEqual(prepared.attachments, []);
    assert.equal(downloads.length, 0);
    await assert.rejects(lstat(root), { code: "ENOENT" });
  });
});

test("only images an agent can take are downloaded; every other file gets a reason", async () => {
  await withRoot(async (root) => {
    const downloads: Download[] = [];
    const prepared = await new RoomTurnAttachmentStager(root).prepare(prepareInput({
      sourceMessage: { id: "msg_7", text: "Files", attachments: [
        attachment("att_1"),
        attachment("att_2", { filename: "notes.pdf", content_type: "application/pdf" }),
        attachment("att_3", { byte_size: ROOM_TURN_IMAGE_MAX_BYTES + 1 }),
        attachment("att_4", { filename: "fake.png" }),
        attachment("att_5", { filename: "broken.png" }),
        attachment("not-an-attachment-id"),
      ] },
    }, downloads, (id) => id === "att_4" ? new TextEncoder().encode("<html>not an image</html>")
      : id === "att_5" ? new RoomAttachmentDownloadError("unavailable") : PNG));
    assert.deepEqual(prepared.attachments.map(file => [file.index, file.status]), [
      [1, "image"], [2, "not_image"], [3, "too_large"], [4, "not_image"], [5, "unavailable"], [6, "unavailable"],
    ]);
    assert.deepEqual(prepared.attachments[0], { index: 1, fileName: "att_1.png", mimeType: "image/png", sizeBytes: PNG.byteLength,
      status: "image", image: { mimeType: "image/png", data: PNG } });
    assert.deepEqual(downloads.map(item => item.attachmentId), ["att_1", "att_4", "att_5"]);
    assert.ok(downloads.every(item => item.messageId === "msg_7" && item.bearer === "worker-bearer"));
    // Bytes stay in memory for this delivery: nothing is written to disk.
    await assert.rejects(lstat(root), { code: "ENOENT" });
  });
});

test("an agent that cannot take images downloads nothing", async () => {
  await withRoot(async (root) => {
    const downloads: Download[] = [];
    const stager = new RoomTurnAttachmentStager(root);
    const unsupported = await stager.prepare(prepareInput({ delivery: null }, downloads));
    assert.deepEqual(unsupported.attachments.map(file => file.status), ["provider_unsupported"]);
    const local = await stager.prepare(prepareInput({ delivery: null, localRoom: true,
      sourceMessage: { id: "msg_7", text: "Look", attachments: [attachment("local:3f1c")] } }, downloads));
    assert.deepEqual(local.attachments.map(file => file.status), ["provider_unsupported"]);
    assert.equal(downloads.length, 0);
  });
});

test("a local room's images are read by their local ids and checked like hosted ones", async () => {
  await withRoot(async (root) => {
    const downloads: Download[] = [];
    const fake = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const big = new Uint8Array(9 * 1024 * 1024); big.set(PNG);
    const prepared = await new RoomTurnAttachmentStager(root).prepare(prepareInput({
      localRoom: true, roomId: "local_room", apiUrl: "letagents-local://rooms", bearer: "local-worker-bearer",
      sourceMessage: { id: "msg_7", text: "Local files", attachments: [
        attachment("local:3f1c0a62-1111-4222-8333-944455556666", { filename: undefined, file_name: "shot.png", content_type: undefined, mime_type: "image/png", byte_size: undefined, size_bytes: PNG.byteLength }),
        attachment("8d2e47a0-1111-4222-8333-944455556666"),
        attachment("att_4"),
        attachment("local:fake"),
        attachment("local:big", { byte_size: big.byteLength }),
        attachment("local:big-2", { byte_size: big.byteLength }),
        attachment("local:big-3", { byte_size: big.byteLength }),
        attachment("../../etc/passwd"),
        attachment("local:gone"),
      ] },
    }, downloads, (id) => id === "local:fake" ? fake : id.startsWith("local:big") ? big
      : id === "local:gone" ? new RoomAttachmentDownloadError("unavailable") : PNG));
    assert.deepEqual(prepared.attachments.map(file => [file.fileName, file.status]), [
      ["shot.png", "image"], ["8d2e47a0-1111-4222-8333-944455556666.png", "image"], ["att_4.png", "image"],
      ["local:fake.png", "not_image"], ["local:big.png", "image"], ["local:big-2.png", "image"], ["local:big-3.png", "turn_limit"],
      ["../../etc/passwd.png", "unavailable"], ["local:gone.png", "unavailable"],
    ]);
    assert.deepEqual(prepared.attachments[0], { index: 1, fileName: "shot.png", mimeType: "image/png", sizeBytes: PNG.byteLength,
      status: "image", image: { mimeType: "image/png", data: PNG } });
    assert.deepEqual(downloads.map(item => item.attachmentId), ["local:3f1c0a62-1111-4222-8333-944455556666",
      "8d2e47a0-1111-4222-8333-944455556666", "att_4", "local:fake", "local:big", "local:big-2", "local:gone"]);
    assert.ok(downloads.every(item => item.messageId === "msg_7" && item.bearer === "local-worker-bearer"));
    await assert.rejects(lstat(root), { code: "ENOENT" }, "memory delivery writes nothing in a local room either");
  });
});

test("a local room stages a file for a provider that reads one", async () => {
  await withRoot(async (root) => {
    const prepared = await new RoomTurnAttachmentStager(root).prepare(prepareInput({
      delivery: "file", localRoom: true, apiUrl: "letagents-local://rooms",
      sourceMessage: { id: "msg_7", text: "Local", attachments: [attachment("local:abc", { content_type: "image/jpeg" })] },
    }, [], () => JPEG));
    const [file] = prepared.attachments;
    assert.equal(file?.status, "image");
    assert.equal(file?.image?.mimeType, "image/jpeg");
    assert.match(file?.image?.path ?? "", /\/1\.jpg$/);
    assert.deepEqual(new Uint8Array(await readFile(file!.image!.path!)), JPEG);
    await prepared.release();
    await assert.rejects(lstat(file!.image!.path!), { code: "ENOENT" });
  });
});

test("the images of one message share a 20 MB turn budget", async () => {
  await withRoot(async (root) => {
    const downloads: Download[] = [];
    const big = new Uint8Array(9 * 1024 * 1024); big.set(PNG);
    const prepared = await new RoomTurnAttachmentStager(root).prepare(prepareInput({
      sourceMessage: { id: "msg_7", text: "Three", attachments: [
        attachment("att_1", { byte_size: big.byteLength }), attachment("att_2", { byte_size: big.byteLength }),
        attachment("att_3", { byte_size: big.byteLength }), attachment("att_4", { byte_size: null }),
      ] },
    }, downloads, (id) => id === "att_4" ? new RoomAttachmentDownloadError("too_large") : big));
    assert.deepEqual(prepared.attachments.map(file => file.status), ["image", "image", "turn_limit", "turn_limit"]);
    assert.deepEqual(downloads.map(item => [item.attachmentId, item.maxBytes]), [
      ["att_1", ROOM_TURN_IMAGE_MAX_BYTES], ["att_2", ROOM_TURN_IMAGE_MAX_BYTES], ["att_4", 2 * 1024 * 1024],
    ]);
  });
});

test("a file after the turn budget is spent exactly is over the turn limit, with no request", async () => {
  await withRoot(async (root) => {
    const downloads: Download[] = [];
    const full = new Uint8Array(ROOM_TURN_IMAGE_MAX_BYTES); full.set(PNG);
    const prepared = await new RoomTurnAttachmentStager(root).prepare(prepareInput({
      sourceMessage: { id: "msg_7", text: "Three", attachments: [
        attachment("att_1", { byte_size: full.byteLength }), attachment("att_2", { byte_size: full.byteLength }),
        attachment("att_3", { byte_size: null }), attachment("att_4", { byte_size: 0 }),
      ] },
    }, downloads, () => full));
    assert.deepEqual(prepared.attachments.map(file => file.status), ["image", "image", "turn_limit", "turn_limit"]);
    assert.deepEqual(downloads.map(item => item.attachmentId), ["att_1", "att_2"]);
  });
});

test("a provider that reads a file gets a private daemon-owned copy, removed on release", async () => {
  await withRoot(async (root) => {
    const stager = new RoomTurnAttachmentStager(root);
    const prepared = await stager.prepare(prepareInput({ delivery: "file",
      sourceMessage: { id: "msg_7", text: "Two", attachments: [attachment("att_1", { filename: "../../etc/passwd" }), attachment("att_2")] },
    }, [], (id) => id === "att_1" ? JPEG : WEBP));
    const [first, second] = prepared.attachments;
    assert.equal(first?.status, "image");
    assert.equal(first?.mimeType, "image/jpeg", "the bytes decide the type");
    assert.equal(first?.fileName, "../../etc/passwd", "the sender's name is shown, never used as a path");
    const path = first!.image!.path!;
    assert.equal(first!.image!.data, undefined);
    assert.match(path, /\/room-turn-attachments\/turn-[^/]+\/1\.jpg$/);
    assert.match(second!.image!.path!, /\/2\.webp$/);
    assert.deepEqual(await readFile(path), Buffer.from(JPEG));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(path, ".."))).mode & 0o777, 0o700);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    await prepared.release();
    await prepared.release();
    assert.deepEqual(await readdir(root), []);
  });
});

test("Stop during preparation rejects and leaves no staged file", async () => {
  await withRoot(async (root) => {
    const controller = new AbortController();
    const stager = new RoomTurnAttachmentStager(root);
    await assert.rejects(stager.prepare(prepareInput({ delivery: "file", signal: controller.signal,
      sourceMessage: { id: "msg_7", text: "Two", attachments: [attachment("att_1"), attachment("att_2")] },
    }, [], (id) => {
      if (id === "att_2") { controller.abort(new Error("stopped")); return new RoomAttachmentDownloadError("unavailable"); }
      return PNG;
    })), /stopped/);
    assert.deepEqual(await readdir(root), []);
  });
});

test("a symlinked staging root is refused, and the turn gets a note instead", async () => {
  const parent = await mkdtemp(join(tmpdir(), "room-turn-attachments-link-"));
  try {
    const target = join(parent, "elsewhere");
    await mkdir(target);
    const root = join(parent, "room-turn-attachments");
    await symlink(target, root);
    const prepared = await new RoomTurnAttachmentStager(root).prepare(prepareInput({ delivery: "file" }));
    assert.deepEqual(prepared.attachments.map(file => file.status), ["unavailable"]);
    assert.deepEqual(await readdir(target), []);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("a sweep removes only old staged folders that no turn still holds", async () => {
  await withRoot(async (root) => {
    let now = Date.now();
    const stager = new RoomTurnAttachmentStager(root, () => now);
    const held = await stager.prepare(prepareInput({ delivery: "file" }));
    const heldFolder = join(held.attachments[0]!.image!.path!, "..");
    const old = join(root, "turn-left-by-an-earlier-process");
    const recent = join(root, "turn-recent");
    const unrelated = join(root, "not-a-turn-folder");
    for (const folder of [old, recent, unrelated]) await mkdir(folder);
    const past = new Date(now - STAGED_FOLDER_MAX_AGE_MS - 60_000);
    await utimes(old, past, past);
    await utimes(unrelated, past, past);
    await utimes(heldFolder, past, past);
    await stager.sweep();
    assert.deepEqual((await readdir(root)).sort(), [heldFolder.split("/").at(-1), "not-a-turn-folder", "turn-recent"].sort());
    await held.release();
    now += STAGED_FOLDER_MAX_AGE_MS * 2;
    await stager.sweep();
    assert.deepEqual((await readdir(root)).sort(), ["not-a-turn-folder"]);
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function withServers(run: (servers: { api: string; storage: string; apiRequests: IncomingMessage[]; storageRequests: IncomingMessage[];
  setApi: (handler: (request: IncomingMessage, respond: (status: number, headers?: Record<string, string>) => void) => void) => void;
  setStorage: (body: Uint8Array, headers?: Record<string, string>) => void }) => Promise<void>): Promise<void> {
  const apiRequests: IncomingMessage[] = [];
  const storageRequests: IncomingMessage[] = [];
  let apiHandler: (request: IncomingMessage, respond: (status: number, headers?: Record<string, string>) => void) => void = () => {};
  let storageBody: Uint8Array = PNG;
  let storageHeaders: Record<string, string> = {};
  const api = createServer((request, response) => {
    apiRequests.push(request);
    apiHandler(request, (status, headers = {}) => { response.writeHead(status, headers); response.end("{}"); });
  });
  const storage = createServer((request, response) => {
    storageRequests.push(request);
    response.writeHead(200, { "content-type": "image/png", ...storageHeaders });
    response.end(Buffer.from(storageBody));
  });
  const apiUrl = await listen(api);
  const storageUrl = await listen(storage);
  try {
    await run({ api: apiUrl, storage: storageUrl, apiRequests, storageRequests,
      setApi: (handler) => { apiHandler = handler; },
      setStorage: (body, headers = {}) => { storageBody = body; storageHeaders = headers; } });
  } finally {
    api.closeAllConnections(); storage.closeAllConnections();
    await Promise.all([new Promise((resolve) => api.close(resolve)), new Promise((resolve) => storage.close(resolve))]);
  }
}

const downloadInput = (apiUrl: string, overrides: Record<string, unknown> = {}) => ({
  roomId: "github.com/BrosInCode/letagents", apiUrl, bearer: "worker-bearer", messageId: "msg_7", attachmentId: "att_2",
  maxBytes: 1024, signal: AbortSignal.timeout(10_000), ...overrides,
});

test("the bearer goes only to the room API; the storage address is fetched with no credential", async () => {
  await withServers(async ({ api, storage, apiRequests, storageRequests, setApi }) => {
    setApi((_request, respond) => respond(302, { location: `${storage}/bucket/object?X-Amz-Signature=secret` }));
    const bytes = await downloadRoomAttachment(downloadInput(api));
    assert.deepEqual(Buffer.from(bytes), Buffer.from(PNG));
    assert.equal(apiRequests[0]?.url, "/rooms/github.com/BrosInCode/letagents/messages/msg_7/attachments/att_2");
    assert.equal(apiRequests[0]?.headers.authorization, "Bearer worker-bearer");
    assert.equal(storageRequests[0]?.url, "/bucket/object?X-Amz-Signature=secret");
    assert.equal(storageRequests[0]?.headers.authorization, undefined);
    assert.equal(storageRequests[0]?.headers.cookie, undefined);
  });
});

test("a refusal from an older server is only this file being unavailable, never a room authorization error", async () => {
  await withServers(async ({ api, storageRequests, setApi }) => {
    for (const status of [401, 403, 404, 503, 200]) {
      setApi((_request, respond) => respond(status));
      await assert.rejects(downloadRoomAttachment(downloadInput(api)), (error: unknown) =>
        error instanceof RoomAttachmentDownloadError && error.reason === "unavailable"
        && !/http|bearer|worker/i.test(error.message));
    }
    assert.equal(storageRequests.length, 0);
  });
});

test("a storage address that is relative, plain HTTP off this machine, or carries credentials is never fetched", async () => {
  await withServers(async ({ api, storageRequests, setApi, storage }) => {
    const port = new URL(storage).port;
    for (const location of ["/rooms/room_1/raw", "http://example.test/object", `http://user:pass@127.0.0.1:${port}/object`, "file:///etc/passwd", "data:image/png;base64,AAAA"]) {
      setApi((_request, respond) => respond(302, { location }));
      await assert.rejects(downloadRoomAttachment(downloadInput(api)), RoomAttachmentDownloadError);
    }
    assert.equal(storageRequests.length, 0);
  });
});

test("a body over the limit is refused, by its declared length or by its counted bytes", async () => {
  await withServers(async ({ api, storage, setApi, setStorage }) => {
    setApi((_request, respond) => respond(302, { location: `${storage}/object` }));
    setStorage(new Uint8Array(2048));
    await assert.rejects(downloadRoomAttachment(downloadInput(api)), (error: unknown) =>
      error instanceof RoomAttachmentDownloadError && error.reason === "too_large");
    setStorage(new Uint8Array(2048), { "transfer-encoding": "chunked" });
    await assert.rejects(downloadRoomAttachment(downloadInput(api)), (error: unknown) =>
      error instanceof RoomAttachmentDownloadError && error.reason === "too_large");
    setStorage(PNG);
    assert.equal((await downloadRoomAttachment(downloadInput(api))).byteLength, PNG.byteLength);
  });
});

test("a malformed message or attachment id makes no request, in a hosted or a local room", async () => {
  await withServers(async ({ api, apiRequests }) => {
    const local = { apiUrl: "letagents-local://rooms", attachmentId: "local:3f1c" };
    for (const overrides of [{ messageId: "msg_0" }, { attachmentId: "../att_1" }, { attachmentId: "local:3f1c" }, { maxBytes: 0 },
      { ...local, attachmentId: "../local-files/x.png" }, { ...local, attachmentId: "local:a/b" }, { ...local, attachmentId: "" },
      { ...local, messageId: "msg_0" }, { ...local, maxBytes: 1.5 }]) {
      await assert.rejects(downloadRoomAttachment(downloadInput(api, overrides)), (error: unknown) =>
        error instanceof RoomAttachmentDownloadError && error.reason === "unavailable");
    }
    assert.equal(apiRequests.length, 0);
  });
});

test("an abort is reported as the abort, not as an unavailable file", async () => {
  await withServers(async ({ api, setApi }) => {
    const controller = new AbortController();
    setApi(() => controller.abort(new Error("stopped by the owner")));
    await assert.rejects(downloadRoomAttachment(downloadInput(api, { signal: controller.signal })), /stopped by the owner/);
  });
});

test("an abandoned turn keeps its files for the native turn, and a later sweep removes them", async () => {
  await withRoot(async (root) => {
    let now = Date.now();
    const stager = new RoomTurnAttachmentStager(root, () => now);
    const prepared = await stager.prepare(prepareInput({ delivery: "file" }));
    const path = prepared.attachments[0]!.image!.path!;
    prepared.abandon();
    await prepared.release();
    assert.deepEqual(await readFile(path), Buffer.from(PNG), "release after abandon changes nothing");
    await stager.sweep();
    assert.deepEqual(await readFile(path), Buffer.from(PNG), "a young folder survives the sweep");
    now += STAGED_FOLDER_MAX_AGE_MS + 1_000;
    await stager.sweep();
    assert.deepEqual(await readdir(root), []);
  });
});

test("one deadline covers all of a turn's downloads, so a stalled store holds the turn back once", async () => {
  // AbortSignal.timeout does not keep a process alive; the daemon always has other work, a test does not.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await withRoot(async (root) => {
      const started = Date.now();
      const signals: AbortSignal[] = [];
      const prepared = await new RoomTurnAttachmentStager(root, Date.now, 100).prepare({ ...prepareInput({
        sourceMessage: { id: "msg_7", text: "Three", attachments: [attachment("att_1"), attachment("att_2"), attachment("att_3")] },
      }), http: {
        downloadAttachment: ({ signal }: { signal: AbortSignal }) => new Promise<Uint8Array>((_resolve, reject) => {
          signals.push(signal);
          if (signal.aborted) { reject(signal.reason); return; }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      } });
      assert.deepEqual(prepared.attachments.map(file => file.status), ["unavailable", "unavailable", "unavailable"]);
      assert.ok(Date.now() - started < 1_000, "the later downloads do not each wait a full deadline");
      assert.equal(new Set(signals).size, 1, "every download shares the one deadline");
    });
  } finally { clearInterval(keepAlive); }
});

test("only a room API on this machine may send the daemon to this machine", () => {
  const refused = (location: string, apiUrl: string) => assert.throws(() => attachmentStorageUrl(location, apiUrl), RoomAttachmentDownloadError, `${location} from ${apiUrl}`);
  const remote = "https://letagents.chat";
  assert.equal(attachmentStorageUrl("https://bucket.example.test/object?X-Amz-Signature=x", remote).hostname, "bucket.example.test");
  for (const location of ["http://127.0.0.1:9000/object", "https://127.0.0.1/object", "https://[::1]/object", "https://localhost/object",
    "http://bucket.example.test/object", "https://user:pass@bucket.example.test/object", "/relative", "ftp://bucket.example.test/x"]) {
    refused(location, remote);
  }
  const local = "http://127.0.0.1:3001";
  assert.equal(attachmentStorageUrl("http://127.0.0.1:9000/bucket/object", local).port, "9000");
  assert.equal(attachmentStorageUrl("https://bucket.example.test/object", local).protocol, "https:");
  refused("http://bucket.example.test/object", local);
});

test("a remote room API cannot point the daemon at this machine by any address form", async () => {
  const remote = "https://letagents.chat";
  for (const location of ["https://127.0.0.2/object", "https://[::ffff:127.0.0.1]/object", "https://169.254.169.254/latest",
    "https://0.0.0.0/object", "https://[fe80::1]/object", "https://[::]/object", "https://storage.localhost/object"]) {
    assert.throws(() => attachmentStorageUrl(location, remote), RoomAttachmentDownloadError, location);
  }
  assert.equal(attachmentStorageUrl("https://10.0.0.5/bucket/object", remote).hostname, "10.0.0.5", "self-hosted storage on a private network stays reachable");
  for (const address of ["127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "0.0.0.0", "169.254.1.1", "fe80::1", "[::1]"]) assert.ok(isThisMachineAddress(address), address);
  for (const address of ["10.0.0.5", "192.168.1.2", "172.16.0.1", "8.8.8.8", "2001:db8::1", "fd00::1", "::ffff:a00:5"]) assert.ok(!isThisMachineAddress(address), address);
  const live = new AbortController().signal;
  const resolver = (addresses: string[] | Error) => async () => {
    if (addresses instanceof Error) throw addresses;
    return addresses.map(address => ({ address }));
  };
  assert.equal(await storageResolvesToThisMachine("bucket.example.test", live, resolver(["203.0.113.7"])), false);
  assert.equal(await storageResolvesToThisMachine("bucket.example.test", live, resolver(["10.0.0.5", "fd00::5"])), false);
  assert.equal(await storageResolvesToThisMachine("rebound.example.test", live, resolver(["203.0.113.7", "127.0.0.1"])), true);
  assert.equal(await storageResolvesToThisMachine("missing.example.test", live, resolver([])), true);
  assert.equal(await storageResolvesToThisMachine("missing.example.test", live, resolver(new Error("ENOTFOUND"))), true);
  assert.equal(await storageResolvesToThisMachine("[::1]", live, resolver(["203.0.113.7"])), true, "a literal address is not looked up");
});

test("a link-local room API is another device and gets no loopback trust; a stalled lookup still obeys Stop", async () => {
  for (const apiUrl of ["https://169.254.10.20", "https://[fe80::1]"]) {
    assert.throws(() => attachmentStorageUrl("http://127.0.0.1:8080/object", apiUrl), RoomAttachmentDownloadError, apiUrl);
    assert.throws(() => attachmentStorageUrl("https://127.0.0.1/object", apiUrl), RoomAttachmentDownloadError, apiUrl);
  }
  assert.equal(attachmentStorageUrl("http://127.0.0.1:9000/object", "http://localhost:3001").port, "9000");
  const controller = new AbortController();
  const stalled = storageResolvesToThisMachine("slow.example.test", controller.signal, () => new Promise(() => {}));
  controller.abort(new Error("stopped by the owner"));
  await assert.rejects(stalled, /stopped by the owner/);
});

// Images on recent messages before the activating one.

function roomMessage(id: string, overrides: Record<string, unknown> = {}) {
  return { id, text: `text of ${id}`, sender: `Sender ${id}`, thread_root_id: id, attachments: [attachment(`att_${id.slice(4)}`)], ...overrides };
}

test("a top-level message looks at the five top-level messages just before it, newest first, never its own or later ones", () => {
  const context = [
    roomMessage("msg_1"), roomMessage("msg_2"), roomMessage("msg_3", { attachments: [] }),
    roomMessage("msg_4", { agent_identity: { agent_key: "me", actor_label: "Me", agent_session_id: "session-me" } }),
    roomMessage("msg_5", { sender: "Ada\u0000 \u202eLove\u200blace\u2028" }), roomMessage("msg_6", { thread_root_id: "msg_1" }),
    roomMessage("msg_7"), roomMessage("msg_8", { text: "the activating message" }), roomMessage("msg_9"),
  ];
  const recent = recentRoomImageMessages({ sourceMessage: context[7], sourceMessageId: "msg_8", context, agentSessionId: "session-me" });
  // Top-level msg_2..msg_7 minus the reply msg_6 is the window; msg_3 has no files and msg_4 is this agent's own.
  assert.deepEqual(recent.map(item => [item.messageId, item.sender, item.inThread]), [
    ["msg_7", "Sender msg_7", false], ["msg_5", "Ada Lovelace", false], ["msg_2", "Sender msg_2", false],
  ], "a reply in another thread is not this conversation; names lose hidden and reordering characters");
  assert.equal(recent[0]?.message, context[6], "the message itself is passed on");
  assert.deepEqual(recentRoomImageMessages({ sourceMessage: context[7], sourceMessageId: "not-a-message", context, agentSessionId: "x" }), []);
});

test("an agent far behind the room has no window before its message, only what the context holds", () => {
  const context = [roomMessage("msg_40"), roomMessage("msg_41")];
  assert.deepEqual(recentRoomImageMessages({ sourceMessage: roomMessage("msg_9"), sourceMessageId: "msg_9", context, agentSessionId: "s" }), []);
});

test("a thread reply looks at its thread only: the root, then its latest earlier replies", () => {
  const source = roomMessage("msg_30", { thread_root_id: "msg_2" });
  const thread = { root: roomMessage("msg_2"), replies: [
    roomMessage("msg_10", { thread_root_id: "msg_2" }), roomMessage("msg_20", { thread_root_id: "msg_2" }),
    roomMessage("msg_31", { thread_root_id: "msg_2" }),
  ] };
  const context = [roomMessage("msg_20", { thread_root_id: "msg_2" }), roomMessage("msg_28"), roomMessage("msg_29")];
  const recent = recentRoomImageMessages({ sourceMessage: source, sourceMessageId: "msg_30", context, thread, agentSessionId: "s" });
  assert.deepEqual(recent.map(item => [item.messageId, item.inThread]), [["msg_2", true], ["msg_20", true], ["msg_10", true]],
    "each message once; a reply after the activating message and the main room are left out");
  const replies = Array.from({ length: 8 }, (_, index) => roomMessage(`msg_${10 + index}`, { thread_root_id: "msg_2" }));
  const fromContext = recentRoomImageMessages({ sourceMessage: source, sourceMessageId: "msg_30",
    context: [roomMessage("msg_2"), ...replies], agentSessionId: "s" });
  assert.deepEqual(fromContext.map(item => item.messageId), ["msg_2", "msg_17", "msg_16", "msg_15", "msg_14", "msg_13"],
    "the root, then the five latest earlier replies");
});

test("the message the activating one quotes comes first, from anywhere in what the turn holds", () => {
  const source = roomMessage("msg_30", { reply_to: { id: "msg_4", text: "a preview without files" } });
  const context = [roomMessage("msg_4", { thread_root_id: "msg_1" }), roomMessage("msg_28"), roomMessage("msg_29")];
  const recent = recentRoomImageMessages({ sourceMessage: source, sourceMessageId: "msg_30", context, agentSessionId: "s" });
  assert.deepEqual(recent.map(item => item.messageId), ["msg_4", "msg_29", "msg_28"]);
});

test("only a reply names a thread root, and only an earlier one", () => {
  assert.equal(activatingThreadRootId({ thread_root_id: "msg_2" }, "msg_9"), "msg_2");
  assert.equal(activatingThreadRootId({ thread_root_id: "msg_9" }, "msg_9"), null, "a root is its own thread");
  assert.equal(activatingThreadRootId({ thread_root_id: "msg_12" }, "msg_9"), null);
  assert.equal(activatingThreadRootId({ thread_root_id: "../msg_2" }, "msg_9"), null);
  assert.equal(activatingThreadRootId({}, "msg_9"), null);
});

function recentInput(overrides: Record<string, unknown>, downloads: Download[] = [], bytes?: (id: string) => Uint8Array | Error) {
  return prepareInput({ sourceMessage: { id: "msg_7", text: "please fix this", attachments: [attachment("att_70", { filename: "own.png" })] },
    ...overrides }, downloads, bytes);
}

const recentFrom = (id: string, files: unknown[], overrides: Record<string, unknown> = {}) =>
  ({ messageId: id, sender: `Sender ${id}`, inThread: false, message: { id, text: "", attachments: files }, ...overrides });

test("a recent message's images follow the activating message's, each named by its message and sender", async () => {
  await withRoot(async (root) => {
    const downloads: Download[] = [];
    const prepared = await new RoomTurnAttachmentStager(root).prepare(recentInput({ delivery: "file", recentMessages: [
      recentFrom("msg_6", [attachment("att_60", { filename: "bug.png" }), attachment("att_61", { filename: "log.txt", content_type: "text/plain" })],
        { inThread: true }),
      recentFrom("msg_5", [attachment("att_50", { filename: "bug.png" })]),
    ] }, downloads));
    assert.deepEqual(prepared.attachments.map(file => [file.origin?.messageId ?? "source", file.index, file.status]), [
      ["source", 1, "image"], ["msg_6", 1, "image"], ["msg_5", 1, "image"],
    ], "a recent message's other files stay out: its context lists them");
    assert.deepEqual(prepared.attachments[1]?.origin, { messageId: "msg_6", sender: "Sender msg_6", inThread: true });
    assert.deepEqual(downloads.map(item => [item.messageId, item.attachmentId]), [["msg_7", "att_70"], ["msg_6", "att_60"], ["msg_5", "att_50"]]);
    assert.deepEqual(prepared.attachments.map(file => file.image?.path?.split("/").at(-1)), ["1.png", "2.png", "3.png"],
      "files of two messages with the same index never collide");
    assert.deepEqual(prepared.outcomes, [
      { messageId: "msg_7", attachmentId: "att_70", outcome: "image" }, { messageId: "msg_6", attachmentId: "att_60", outcome: "image" },
      { messageId: "msg_5", attachmentId: "att_50", outcome: "image" },
    ]);
    await prepared.release();
  });
});

test("recent messages add at most four images and 10 MB, inside the turn budget and after the activating message", async () => {
  await withRoot(async (root) => {
    const downloads: Download[] = [];
    const many = await new RoomTurnAttachmentStager(root).prepare(recentInput({ recentMessages: [
      recentFrom("msg_6", [attachment("att_1"), attachment("att_2"), attachment("att_3")]),
      recentFrom("msg_5", [attachment("att_4"), attachment("att_5")]),
    ] }, downloads));
    assert.deepEqual(many.attachments.map(file => file.status), ["image", "image", "image", "image", "image", "context_limit"]);
    assert.equal(downloads.length, 5, "the fifth recent image is not downloaded");

    const six = new Uint8Array(6 * 1024 * 1024); six.set(PNG);
    const bytesCap: Download[] = [];
    const capped = await new RoomTurnAttachmentStager(root).prepare(recentInput({ recentMessages: [
      recentFrom("msg_6", [attachment("att_1", { byte_size: six.byteLength }), attachment("att_2", { byte_size: six.byteLength }),
        attachment("att_3", { byte_size: null })]),
    ] }, bytesCap, (id) => id === "att_3" ? new RoomAttachmentDownloadError("too_large") : six));
    assert.deepEqual(capped.attachments.map(file => file.status), ["image", "image", "context_limit", "context_limit"]);
    assert.deepEqual(bytesCap.map(item => [item.attachmentId, item.maxBytes]), [
      ["att_70", ROOM_TURN_IMAGE_MAX_BYTES], ["att_1", ROOM_TURN_IMAGE_MAX_BYTES], ["att_3", ROOM_TURN_RECENT_IMAGES_MAX_BYTES - six.byteLength],
    ], "an image of unknown size may take only what recent images have left");
    assert.deepEqual(capped.outcomes.map(file => file.outcome), ["image", "image"], "a budget is not a refusal for good");

    const nine = new Uint8Array(9 * 1024 * 1024); nine.set(PNG);
    const turnBudget: Download[] = [];
    const shared = await new RoomTurnAttachmentStager(root).prepare(prepareInput({
      sourceMessage: { id: "msg_7", text: "two big ones", attachments: [attachment("att_70", { byte_size: nine.byteLength }), attachment("att_71", { byte_size: nine.byteLength })] },
      recentMessages: [recentFrom("msg_6", [attachment("att_1", { byte_size: 3 * 1024 * 1024 }), attachment("att_2", { byte_size: null })])],
    }, turnBudget, (id) => id === "att_2" ? new RoomAttachmentDownloadError("too_large") : nine));
    assert.deepEqual(shared.attachments.map(file => file.status), ["image", "image", "turn_limit", "turn_limit"]);
    assert.deepEqual(turnBudget.map(item => [item.attachmentId, item.maxBytes]), [
      ["att_70", ROOM_TURN_IMAGE_MAX_BYTES], ["att_71", ROOM_TURN_IMAGE_MAX_BYTES], ["att_2", 2 * 1024 * 1024],
    ], "an image of unknown size may take only what the turn has left");
  });
});

test("what the conversation already has is not fetched again; the activating message's files always are", async () => {
  await withRoot(async (root) => {
    const downloads: Download[] = [];
    const earlierOutcomes = new Map([
      [roomTurnFileKey("msg_6", "att_60"), "image" as const], [roomTurnFileKey("msg_6", "att_62"), "not_image" as const],
      [roomTurnFileKey("msg_6", "att_63"), "too_large" as const], [roomTurnFileKey("msg_7", "att_70"), "image" as const],
    ]);
    const prepared = await new RoomTurnAttachmentStager(root).prepare(recentInput({ earlierOutcomes, recentMessages: [
      recentFrom("msg_6", [attachment("att_60"), attachment("att_61"), attachment("att_62"), attachment("att_63")]),
    ] }, downloads));
    assert.deepEqual(prepared.attachments.map(file => [file.origin?.messageId ?? "source", file.index, file.status]), [
      ["source", 1, "image"], ["msg_6", 1, "earlier_turn"], ["msg_6", 2, "image"],
    ], "a refusal for good is named once, in the turn that found it");
    assert.deepEqual(downloads.map(item => item.attachmentId), ["att_70", "att_61"]);
  });
});

test("only a refusal by the bytes is remembered for good, so a later turn does not fetch it again", async () => {
  await withRoot(async (root) => {
    const prepared = await new RoomTurnAttachmentStager(root).prepare(recentInput({ recentMessages: [
      recentFrom("msg_6", [attachment("att_1"), attachment("att_2", { byte_size: null }), attachment("att_3")]),
    ] }, [], (id) => id === "att_1" ? new TextEncoder().encode("<html>")
      : id === "att_2" ? new RoomAttachmentDownloadError("too_large")
        : id === "att_3" ? new RoomAttachmentDownloadError("unavailable") : PNG));
    assert.deepEqual(prepared.attachments.map(file => file.status), ["image", "not_image", "too_large", "unavailable"]);
    assert.deepEqual(prepared.outcomes.map(file => [file.attachmentId, file.outcome]), [
      ["att_70", "image"], ["att_1", "not_image"], ["att_2", "too_large"],
    ], "an unavailable file is asked for again next turn");
  });
});

test("received images never crowd new ones out of the notes", async () => {
  await withRoot(async (root) => {
    const earlierOutcomes = new Map<string, "image">();
    const old = Array.from({ length: 12 }, (_, index) => {
      earlierOutcomes.set(roomTurnFileKey("msg_6", `att_${index + 1}`), "image");
      return attachment(`att_${index + 1}`);
    });
    const prepared = await new RoomTurnAttachmentStager(root).prepare(recentInput({ earlierOutcomes, recentMessages: [
      recentFrom("msg_6", old), recentFrom("msg_5", [attachment("att_50")]),
    ] }));
    const statuses = prepared.attachments.map(file => file.status);
    assert.equal(statuses.filter(status => status === "earlier_turn").length, 8, "at most eight received images are named");
    assert.equal(prepared.attachments.at(-1)?.origin?.messageId, "msg_5");
    assert.equal(prepared.attachments.at(-1)?.status, "image");
  });
});

test("recent images have their own short deadline, so a stalled store holds the turn back less for them", async () => {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await withRoot(async (root) => {
      const requested: string[] = [];
      const started = Date.now();
      const prepared = await new RoomTurnAttachmentStager(root, Date.now, 5_000, 100).prepare({ ...recentInput({ recentMessages: [
        recentFrom("msg_6", [attachment("att_1"), attachment("att_2")]),
      ] }), http: {
        downloadAttachment: ({ attachmentId, signal }: { attachmentId: string; signal: AbortSignal }) => {
          requested.push(attachmentId);
          if (attachmentId === "att_70") return Promise.resolve(PNG);
          return new Promise<Uint8Array>((_resolve, reject) => {
            if (signal.aborted) { reject(signal.reason); return; }
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      } });
      assert.deepEqual(prepared.attachments.map(file => file.status), ["image", "unavailable", "unavailable"]);
      assert.deepEqual(requested, ["att_70", "att_1"], "once the recent deadline passed, the rest are not asked for");
      assert.ok(Date.now() - started < 2_000);
    });
  } finally { clearInterval(keepAlive); }
});

test("an agent that cannot take images downloads nothing from recent messages either", async () => {
  await withRoot(async (root) => {
    const downloads: Download[] = [];
    const prepared = await new RoomTurnAttachmentStager(root).prepare(recentInput({ delivery: null,
      recentMessages: [recentFrom("msg_6", [attachment("att_60")])] }, downloads));
    assert.deepEqual(prepared.attachments.map(file => file.status), ["provider_unsupported", "provider_unsupported"]);
    assert.deepEqual(prepared.outcomes.map(file => [file.attachmentId, file.outcome]), [
      ["att_70", "provider_unsupported"], ["att_60", "provider_unsupported"],
    ], "the note is given once per conversation");
    assert.equal(downloads.length, 0);
    const later = await new RoomTurnAttachmentStager(root).prepare(recentInput({ delivery: null, sourceMessage: { id: "msg_8", text: "and now?" },
      sourceMessageId: "msg_8", earlierOutcomes: new Map([[roomTurnFileKey("msg_6", "att_60"), "provider_unsupported" as const]]),
      recentMessages: [recentFrom("msg_6", [attachment("att_60")])] }, downloads));
    assert.deepEqual(later.attachments, [], "a later turn of that conversation is not told again");
  });
});

test("a recent image of a local room is read by its local id", async () => {
  await withRoot(async (root) => {
    const downloads: Download[] = [];
    const prepared = await new RoomTurnAttachmentStager(root).prepare(prepareInput({ localRoom: true,
      sourceMessage: { id: "msg_7", text: "this one" },
      recentMessages: [recentFrom("msg_6", [attachment("local:3f1c"), attachment("../escape")])] }, downloads));
    assert.deepEqual(prepared.attachments.map(file => file.status), ["image", "unavailable"]);
    assert.deepEqual(downloads.map(item => [item.messageId, item.attachmentId]), [["msg_6", "local:3f1c"]]);
  });
});

test("the thread read sends the bearer to the room API only, and any failure or other shape is no thread", async () => {
  await withServers(async ({ api, apiRequests, setApi }) => {
    const input = { roomId: "github.com/BrosInCode/letagents", apiUrl: api, bearer: "worker-bearer",
      rootMessageId: "msg_2", beforeMessageId: "msg_9", limit: 5, signal: AbortSignal.timeout(10_000) };
    for (const status of [401, 403, 404, 500, 200]) {
      setApi((_request, respond) => respond(status));
      assert.equal(await readRoomThread(input), null, `HTTP ${status} with a body that is not a thread is no thread, never a refusal`);
    }
    assert.equal(apiRequests[0]?.url, "/rooms/github.com/BrosInCode/letagents/messages/msg_2/thread?before=msg_9&limit=5");
    assert.equal(apiRequests[0]?.headers.authorization, "Bearer worker-bearer");
    const before = apiRequests.length;
    assert.equal(await readRoomThread({ ...input, rootMessageId: "msg_2/../x" }), null);
    assert.equal(apiRequests.length, before, "a malformed id makes no request");
    const controller = new AbortController();
    setApi(() => controller.abort(new Error("stopped by the owner")));
    await assert.rejects(readRoomThread({ ...input, signal: controller.signal }), /stopped by the owner/);
  });
});

test("a thread page is accepted only for its room and root", async () => {
  const pages: unknown[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(pages.shift()));
  });
  const api = await listen(server);
  try {
    const input = { roomId: "room_1", apiUrl: api, bearer: "b", rootMessageId: "msg_2", beforeMessageId: "msg_9", limit: 2,
      signal: AbortSignal.timeout(10_000) };
    const root = { id: "msg_2", text: "root" };
    const replies = [{ id: "msg_3", text: "a" }, { id: "msg_4", text: "b" }, { id: "msg_5", text: "c" }];
    pages.push({ room_id: "room_1", root, replies });
    assert.deepEqual(await readRoomThread(input), { root, replies: replies.slice(-2) });
    pages.push({ room_id: "room_2", root, replies });
    assert.equal(await readRoomThread(input), null);
    pages.push({ room_id: "room_1", root: { id: "msg_7", text: "other" }, replies });
    assert.equal(await readRoomThread(input), null);
    // What an older local supervisor answers: the room page.
    pages.push({ room_id: "room_1", messages: [root], has_more: false });
    assert.equal(await readRoomThread(input), null);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a message the room context lacks carries the start of its text, since the prompt does not show it", () => {
  const source = roomMessage("msg_30", { thread_root_id: "msg_2" });
  const thread = { root: roomMessage("msg_2", { text: "The login page\u202e is broken\nafter the update", sender: "Grace" }), replies: [] };
  const context = [roomMessage("msg_20", { thread_root_id: "msg_2", text: "in the context" })];
  const recent = recentRoomImageMessages({ sourceMessage: source, sourceMessageId: "msg_30", context, thread, agentSessionId: "s" });
  assert.deepEqual(recent.map(item => [item.messageId, item.preview]), [
    ["msg_2", "The login page is brokenafter the update"], ["msg_20", undefined],
  ]);
});

test("an image refused by its recorded size is final, and a Cursor image never counts as received", async () => {
  await withRoot(async (root) => {
    const downloads: Download[] = [];
    const prepared = await new RoomTurnAttachmentStager(root).prepare(recentInput({ recentMessages: [
      recentFrom("msg_6", [attachment("att_60", { byte_size: ROOM_TURN_IMAGE_MAX_BYTES + 1 })]),
    ] }, downloads));
    assert.deepEqual(prepared.outcomes.map(file => [file.attachmentId, file.outcome]), [["att_70", "image"], ["att_60", "too_large"]]);
    assert.deepEqual(downloads.map(item => item.attachmentId), ["att_70"]);
    assert.deepEqual(rememberedRoomTurnFiles("cursor", prepared.outcomes).map(file => file.outcome), ["too_large"]);
    assert.deepEqual(rememberedRoomTurnFiles("codex", prepared.outcomes), prepared.outcomes);
  });
});
