import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopRoomMessageAttachment } from "../../electron/ipc-types.js";
import { attachmentCell, attachmentPreviewType, attachmentTable } from "../src/domain/attachment-preview.js";

test("previews legacy text and structured attachments on the desktop protocol", () => {
  const attachment = {
    id: "fixture", fileName: "results.NDJSON", mimeType: "application/octet-stream",
    sizeBytes: 9300, href: "letagents-attachment://download/L3Jvb21z",
  } satisfies DesktopRoomMessageAttachment;
  assert.equal(attachmentPreviewType(attachment), "NDJSON");
  assert.equal(attachmentPreviewType({ ...attachment, fileName: "driver.log", mimeType: "text/plain; charset=utf-8" }), "Log");
  for (const unsupported of [
    { ...attachment, mimeType: "text/html" },
    { ...attachment, fileName: "results.json.exe" },
    { ...attachment, sizeBytes: 1024 * 1024 },
    { ...attachment, href: "https://example.invalid/results.ndjson" },
    { ...attachment, href: "letagents-attachment://download/L3Jvb21z?file=other" },
  ]) assert.equal(attachmentPreviewType(unsupported), null);
});

test("renders heterogeneous JSON objects and treats malformed or lossy data as raw text", () => {
  const result = attachmentTable("NDJSON", '\uFEFF{"test":"startup","ms":120}\r\n{"test":"memory","detail":{"bytes":21}}\r\n');
  assert.ok(result);
  assert.deepEqual(result.columns, ["test", "ms", "detail"]);
  assert.equal(attachmentCell(result.rows[0]!, "ms"), "120");
  assert.equal(attachmentCell(result.rows[1]!, "detail"), '{"bytes":21}');
  assert.equal(attachmentCell(result.rows[1]!, "ms"), "—");
  assert.equal(attachmentCell(result.rows[1]!, "toString"), "—");
  assert.equal(attachmentTable("NDJSON", '{"test":"startup"}\npartial row'), null);
  assert.equal(attachmentTable("JSON", '[{"id":9007199254740993}]'), null);
  assert.equal(attachmentTable("JSON", '[{"id":1e999}]'), null);
  assert.equal(attachmentTable("JSON", '[{"value":' + "[".repeat(8000) + "0" + "]".repeat(8000) + "}]"), null);
});
