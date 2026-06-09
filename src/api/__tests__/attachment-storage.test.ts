import assert from "node:assert/strict";
import test from "node:test";

import {
  createPresignedAttachmentDownload,
  createPresignedAttachmentUpload,
} from "../messages/attachment-storage.js";

process.env.ATTACHMENT_S3_BUCKET = "letagents-attachments-test";
process.env.ATTACHMENT_S3_REGION = "us-east-1";
process.env.ATTACHMENT_S3_ACCESS_KEY_ID = "AKIA1234567890TEST";
process.env.ATTACHMENT_S3_SECRET_ACCESS_KEY = "test-secret-key";
delete process.env.ATTACHMENT_S3_ENDPOINT;
delete process.env.ATTACHMENT_S3_FORCE_PATH_STYLE;

test("createPresignedAttachmentDownload sorts canonical query params in byte order", () => {
  const url = createPresignedAttachmentDownload({
    object_key: "rooms/focus_14/uploads/upl_1234567890abcdef/roomsettings.png",
    filename: "roomsettings.png",
    content_type: "image/png",
  });

  const canonicalQuery = url.split("?")[1]?.split("&X-Amz-Signature=")[0];
  assert.ok(canonicalQuery, "expected a presigned query string");

  const parameterNames = canonicalQuery
    .split("&")
    .map((part) => part.split("=")[0]);

  assert.deepEqual(parameterNames, [
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-SignedHeaders",
    "response-content-disposition",
    "response-content-type",
  ]);
});

test("createPresignedAttachmentUpload signs the exact content length", () => {
  const target = createPresignedAttachmentUpload({
    object_key: "rooms/focus_14/uploads/upl_1234567890abcdef/roomsettings.png",
    filename: "roomsettings.png",
    content_type: "image/png",
    byte_size: 1234,
  });

  assert.equal(target.headers["Content-Type"], "image/png");
  const url = new URL(target.upload_url);
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host");
  assert.ok(url.searchParams.get("X-Amz-Signature"), "expected presigned PUT signature");
});
