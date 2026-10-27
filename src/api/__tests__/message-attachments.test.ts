import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MESSAGE_ATTACHMENTS,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  canStageMessageAttachment,
  formatAttachmentContentDisposition,
  normalizeAttachmentUploadRequest,
  normalizeMessageAttachmentReferences,
  resolveAttachmentDownloadHeaders,
  resolveMessageAttachmentUploader,
} from "../messages/attachments.js";

test("attachment staging requires an authenticated human or scoped worker", () => {
  assert.equal(canStageMessageAttachment({ authKind: null, sessionAccount: null }), false);
  assert.equal(canStageMessageAttachment({
    authKind: "session",
    sessionAccount: { account_id: "acct_1" } as never,
  }), true);
  assert.equal(canStageMessageAttachment({
    authKind: "agent_session",
    sessionAccount: null,
    agentSession: { agent_session_id: "sess_1" },
  }), true);
  assert.equal(canStageMessageAttachment({ authKind: "agent_session", sessionAccount: null }), false);
  assert.equal(canStageMessageAttachment({ authKind: "supervisor_grant", sessionAccount: null }), false);
});

test("attachment uploads belong to the worker session or the account, never both", () => {
  assert.deepEqual(resolveMessageAttachmentUploader({
    authKind: "agent_session",
    sessionAccount: { account_id: "acct_owner" },
    agentSession: { agent_session_id: "sess_1" },
  }), { account_id: null, agent_session_id: "sess_1" });
  assert.deepEqual(resolveMessageAttachmentUploader({
    authKind: "owner_token",
    sessionAccount: { account_id: "acct_1" },
    agentSession: null,
  }), { account_id: "acct_1", agent_session_id: null });
  assert.deepEqual(resolveMessageAttachmentUploader({
    authKind: "session",
    sessionAccount: { account_id: "acct_2" },
  }), { account_id: "acct_2", agent_session_id: null });
  assert.equal(resolveMessageAttachmentUploader({ authKind: "session", sessionAccount: { account_id: " " } }), null);
});

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

test("formatAttachmentContentDisposition escapes filenames and downloads by default", () => {
  assert.equal(
    formatAttachmentContentDisposition('bad"name.png'),
    'attachment; filename="bad_name.png"'
  );
  assert.equal(
    formatAttachmentContentDisposition('bad"name.png', "inline"),
    'inline; filename="bad_name.png"'
  );
});

test("downloads open only passive types in the browser tab", () => {
  for (const contentType of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]) {
    assert.deepEqual(
      resolveAttachmentDownloadHeaders({ filename: "file", content_type: contentType }),
      { content_disposition: 'inline; filename="file"', content_type: contentType },
      contentType,
    );
  }
});

test("HTML and other scriptable types download as plain bytes", () => {
  for (const contentType of [
    "text/html",
    "TEXT/HTML",
    "application/xhtml+xml",
    "text/xml",
    "application/xml",
    "application/rss+xml",
    "text/javascript",
    "application/javascript",
    "application/x-javascript",
    "text/xsl",
    "multipart/x-mixed-replace",
  ]) {
    assert.deepEqual(
      resolveAttachmentDownloadHeaders({ filename: "demo.html", content_type: contentType }),
      { content_disposition: 'attachment; filename="demo.html"', content_type: "application/octet-stream" },
      contentType,
    );
  }
});

test("SVG keeps its image type for image tags but never opens as a page", () => {
  assert.deepEqual(
    resolveAttachmentDownloadHeaders({ filename: "diagram.svg", content_type: "image/svg+xml" }),
    { content_disposition: 'attachment; filename="diagram.svg"', content_type: "image/svg+xml" },
  );
});

test("other and malformed types download with a safe type", () => {
  assert.deepEqual(
    resolveAttachmentDownloadHeaders({ filename: "data.json", content_type: "application/json" }),
    { content_disposition: 'attachment; filename="data.json"', content_type: "application/json" },
  );
  assert.deepEqual(
    resolveAttachmentDownloadHeaders({ filename: "page.html", content_type: "text/html; charset=utf-8" }),
    { content_disposition: 'attachment; filename="page.html"', content_type: "application/octet-stream" },
  );
  assert.deepEqual(
    resolveAttachmentDownloadHeaders({ filename: "x", content_type: "" }),
    { content_disposition: 'attachment; filename="x"', content_type: "application/octet-stream" },
  );
});
