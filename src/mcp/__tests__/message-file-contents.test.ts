import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

// Files an agent gives as content: decoded and checked before any upload.
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { readMessageFileContents } = await import("../server/runtime/message-attachments.js");
const { MESSAGE_ATTACHMENT_LIMITS } = await import("../../../shared/message-attachments.mjs");

test("a large image in base64 decodes, wrapped or not, without exhausting the regex engine", () => {
  const bytes = randomBytes(6 * 1024 * 1024);
  const wrapped = bytes.toString("base64").replace(/.{76}/g, "$&\n");
  const [file] = readMessageFileContents([{ name: "big.png", content: wrapped, encoding: "base64" }]);
  assert.equal(file!.mimeType, "image/png");
  assert.ok(file!.bytes.equals(bytes));
});

test("text keeps its bytes, names lose their folders, and the type comes from the name", () => {
  const [html, plain] = readMessageFileContents([{ name: "../site/demo.HTML", content: "<p>é</p>" }, { name: "notes", content: "x" }]);
  assert.deepEqual([html!.name, html!.mimeType, html!.bytes.toString("utf8")], ["demo.HTML", "text/html", "<p>é</p>"]);
  assert.deepEqual([plain!.name, plain!.mimeType], ["notes", "application/octet-stream"]);
});

test("bad base64, empty files, credential names and files over the limits are refused, saying nothing was posted", () => {
  for (const [file, pattern] of [
    [{ name: "a.bin", content: "abc", encoding: "base64" }, /not valid base64/],
    [{ name: "a.bin", content: "ab=c", encoding: "base64" }, /not valid base64/],
    [{ name: "a.bin", content: "!!!!", encoding: "base64" }, /not valid base64/],
    [{ name: "a.txt", content: "", encoding: "base64" }, /empty/],
    [{ name: "id_rsa", content: "key" }, /credentials/],
    [{ name: ".env", content: "A=1" }, /credentials/],
  ] as const) {
    assert.throws(() => readMessageFileContents([file]), (error: Error) => pattern.test(error.message) && /Nothing was posted/.test(error.message), JSON.stringify(file));
  }
  assert.throws(() => readMessageFileContents([{ name: "a.txt", content: "xx" }], MESSAGE_ATTACHMENT_LIMITS.maxTotalBytes - 1),
    /larger than 100 MB together/, "files read from the workspace count toward the total");
});
