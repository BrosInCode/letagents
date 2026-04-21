import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MESSAGE_ATTACHMENTS,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  formatAttachmentContentDisposition,
  normalizeAttachmentUploadRequest,
  normalizeMessageAttachmentReferences,
} from "../message-attachments.js";

test("normalizeAttachmentUploadRequest accepts frontend metadata aliases", () => {
  const attachment = normalizeAttachmentUploadRequest({
    file_name: "../roomsettings.png",
    mime_type: "IMAGE/PNG",
    size_bytes: 1024,
  });

  assert.deepEqual(attachment, {
    filename: "roomsettings.png",
    content_type: "image/png",
    byte_size: 1024,
  });
});

test("normalizeAttachmentUploadRequest rejects invalid sizes", () => {
  assert.throws(
    () => normalizeAttachmentUploadRequest({ filename: "empty.txt", byte_size: 0 }),
    /positive integer/
  );
  assert.throws(
    () => normalizeAttachmentUploadRequest({
      filename: "big.bin",
      byte_size: MAX_MESSAGE_ATTACHMENT_BYTES + 1,
    }),
    /exceeds/
  );
});

test("normalizeMessageAttachmentReferences accepts upload ids", () => {
  assert.deepEqual(
    normalizeMessageAttachmentReferences([
      { upload_id: "upl_1234567890abcdef" },
      "upl_abcdef1234567890",
    ]),
    [
      { upload_id: "upl_1234567890abcdef" },
      { upload_id: "upl_abcdef1234567890" },
    ]
  );
});

test("normalizeMessageAttachmentReferences rejects invalid references", () => {
  assert.throws(
    () => normalizeMessageAttachmentReferences(new Array(MAX_MESSAGE_ATTACHMENTS + 1).fill({
      upload_id: "upl_1234567890abcdef",
    })),
    /at most/
  );
  assert.throws(
    () => normalizeMessageAttachmentReferences([{ upload_id: "bad" }]),
    /valid upload_id/
  );
  assert.throws(
    () => normalizeMessageAttachmentReferences([
      { upload_id: "upl_1234567890abcdef" },
      { upload_id: "upl_1234567890abcdef" },
    ]),
    /duplicate/
  );
});

test("formatAttachmentContentDisposition escapes filenames", () => {
  assert.equal(
    formatAttachmentContentDisposition('bad"name.png'),
    'inline; filename="bad_name.png"'
  );
});
