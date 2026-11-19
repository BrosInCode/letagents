import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, describe, it, mock } from "node:test";

import { makePdf } from "../pdf-text/__tests__/make-pdf.js";

/** Attachments of one message, by id, as the database returns them. */
const attachments: Record<string, { filename: string; content_type: string; byte_size: number; object_key: string; bytes: Uint8Array }> = {};
const add = (id: string, filename: string, contentType: string, bytes: Uint8Array) => {
  attachments[id] = { filename, content_type: contentType, byte_size: bytes.byteLength, object_key: `room/${id}`, bytes };
};
/** About 30,000 characters on one page: short lines in a small font, so they fit on it. */
const lines = (count: number, char: string) => Array.from({ length: count }, () => char.repeat(99)).join("\n");
const LONG_PAGE = lines(300, "w");
add("att_1", "spec.pdf", "application/pdf", makePdf(["Spec\nintro", "Section two"]));
add("att_2", "five.pdf", "application/pdf", makePdf([LONG_PAGE, LONG_PAGE, "short", LONG_PAGE, "end"], { fontSize: 2 }));
add("att_3", "notes.txt", "text/plain", new TextEncoder().encode("plain text"));
add("att_4", "renamed.pdf", "application/pdf", new TextEncoder().encode("<html>not a pdf</html>"));
add("att_5", "locked.pdf", "application/pdf", makePdf(["secret"], { encrypted: true }));
add("att_6", "huge-page.pdf", "application/pdf", makePdf([lines(600, "h"), "after"], { fontSize: 1 }));
add("att_7", "gone.pdf", "application/pdf", makePdf(["x"]));
add("att_8", "SCAN.PDF", "application/octet-stream", makePdf([""]));
attachments.att_9 = { ...attachments.att_1!, object_key: "room/att_9", byte_size: 30 * 1024 * 1024 };
add("att_10", "slow-a.pdf", "application/pdf", makePdf(["a"]));
add("att_11", "slow-b.pdf", "application/pdf", makePdf(["b"]));
add("att_12", "third.pdf", "application/pdf", makePdf(["c"]));

/** Storage answers for these keys wait until the test lets them go. */
const held = new Set(["room/att_10", "room/att_11"]);
const waiting: Array<() => void> = [];

const storageHits: string[] = [];
let storageConfigured = true;
const storage = createServer((req, res) => {
  const key = decodeURIComponent(new URL(req.url!, "http://storage").pathname.slice(1));
  storageHits.push(key);
  const file = Object.values(attachments).find((entry) => entry.object_key === key);
  if (!file || key === "room/att_7") {
    res.writeHead(500);
    res.end("storage error");
    return;
  }
  const send = () => {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(file.bytes.byteLength) });
    res.end(Buffer.from(file.bytes));
  };
  if (held.has(key)) waiting.push(send);
  else send();
});

interface Answer { status: number; body: Record<string, unknown>; headers: Record<string, string> }

describe("the PDF text view of a message attachment", () => {
  let respond: typeof import("../routes/rooms/messages/attachment-text.js").respondWithAttachmentText;
  const mocks: Array<{ restore: () => void }> = [];

  before(async () => {
    storage.listen(0, "127.0.0.1");
    await once(storage, "listening");
    const base = `http://127.0.0.1:${(storage.address() as { port: number }).port}`;
    mocks.push(
      mock.module("../db.js", { namedExports: {
        getMessageAttachment: async (_room: string, _message: string, id: string) => {
          const file = attachments[id];
          return file && { ...file, id, bucket: "bucket", file_name: file.filename, mime_type: file.content_type, size_bytes: file.byte_size };
        },
      } }),
      mock.module("../messages/attachment-storage.js", { namedExports: {
        createPresignedAttachmentDownload: (file: { object_key: string }) => `${base}/${encodeURIComponent(file.object_key)}`,
        isAttachmentStorageConfigured: () => storageConfigured,
      } }),
    );
    ({ respondWithAttachmentText: respond } = await import("../routes/rooms/messages/attachment-text.js"));
  });

  after(() => {
    for (const stub of mocks.reverse()) stub.restore();
    storage.close();
  });

  async function ask(attachmentId: string, page?: string, requester = "acct_emmy"): Promise<Answer> {
    const answer: Answer = { status: 0, body: {}, headers: {} };
    const res = {
      status(code: number) { answer.status = code; return res; },
      json(value: Record<string, unknown>) { answer.body = value; return res; },
      setHeader(name: string, value: string) { answer.headers[name] = value; },
    };
    await respond(res as never, "room_1", "msg_1", attachmentId, page, requester);
    return answer;
  }

  it("gives a PDF's text whole pages at a time, and reads it from storage once", async () => {
    const answer = await ask("att_1");
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, {
      ok: true, kind: "pdf", page_count: 2, read_pages: 2, truncated: false, first_page: 1, last_page: 2, has_text: true,
      pages: [{ page: 1, text: "Spec\nintro" }, { page: 2, text: "Section two" }],
    });
    assert.equal((await ask("att_1", "2")).body.first_page, 2);
    assert.equal(storageHits.filter((key) => key === "room/att_1").length, 1, "the text is kept, so storage is asked once");
  });

  it("stops before a page that would pass about 50,000 characters, and gives next_page", async () => {
    const first = await ask("att_2");
    assert.deepEqual([first.body.first_page, first.body.last_page, first.body.next_page], [1, 1, 2]);
    const second = await ask("att_2", "2");
    assert.deepEqual([second.body.first_page, second.body.last_page, second.body.next_page], [2, 3, 4]);
    const last = await ask("att_2", "4");
    assert.deepEqual([last.body.last_page, last.body.next_page], [5, undefined]);
  });

  it("cuts a page longer than one answer and says so", async () => {
    const answer = await ask("att_6");
    const pages = answer.body.pages as Array<{ page: number; text: string; cut?: boolean }>;
    assert.deepEqual(pages.map((entry) => [entry.page, entry.text.length, entry.cut]), [[1, 50_000, true]]);
    assert.equal(answer.body.next_page, 2);
  });

  it("reads a file named .pdf whatever type it was stored with, and says when it has no text", async () => {
    const answer = await ask("att_8");
    assert.equal(answer.status, 200);
    assert.equal(answer.body.has_text, false);
  });

  it("answers busy with Retry-After when every slot is reading, and one account holds one slot", async () => {
    const first = ask("att_10", undefined, "acct_a");
    const second = ask("att_11", undefined, "acct_b");
    while (waiting.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    const busy = await ask("att_12", undefined, "acct_c");
    assert.deepEqual([busy.status, busy.body.code, busy.headers["Retry-After"]], [503, "PDF_BUSY", "5"]);
    held.clear();
    for (const send of waiting.splice(0)) send();
    assert.deepEqual([(await first).status, (await second).status], [200, 200]);
    assert.equal((await ask("att_12", undefined, "acct_c")).status, 200);
  });

  it("refuses with a reason the MCP tool can show", async () => {
    const cases: Array<[string, string | undefined, number, string]> = [
      ["att_3", undefined, 415, "NOT_PDF"],
      ["att_4", undefined, 422, "PDF_INVALID"],
      ["att_5", undefined, 422, "PDF_ENCRYPTED"],
      ["att_7", undefined, 502, "PDF_FETCH_FAILED"],
      ["att_9", undefined, 413, "PDF_TOO_LARGE"],
      ["att_404", undefined, 404, "ATTACHMENT_NOT_FOUND"],
      ["att_1", "0", 400, "INVALID_PAGE"],
      ["att_1", "two", 400, "INVALID_PAGE"],
      ["att_1", "3", 400, "PAGE_OUT_OF_RANGE"],
    ];
    for (const [id, page, status, code] of cases) {
      const answer = await ask(id, page);
      assert.deepEqual([answer.status, answer.body.code], [status, code], `${id} page ${page}`);
    }
    assert.ok(!storageHits.includes("room/att_3"), "a file that is not a PDF is not fetched");
    assert.ok(!storageHits.includes("room/att_9"), "a PDF over the limit is not fetched");
    storageConfigured = false;
    try {
      const answer = await ask("att_1");
      assert.deepEqual([answer.status, answer.body.error], [503, "Attachment object storage is not configured"]);
    } finally {
      storageConfigured = true;
    }
  });
});
