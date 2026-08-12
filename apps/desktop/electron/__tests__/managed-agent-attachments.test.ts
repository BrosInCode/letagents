import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

const { tempDir, resetState } = createElectronTestEnv({
  prefix: "letagents-managed-agent-attachments-",
  paths: ["state", "localChatDb"],
  extraEnvFiles: {
    LETAGENTS_AGENT_ATTACHMENTS_DIR: "agent-attachments",
  },
});

const {
  cleanupAgentSessionAttachments,
  downloadApiAttachment,
  describeAgentMessageAttachments,
  describeDesktopEventMessageAttachments,
  materializeAgentSessionAttachment,
  toAgentReadableRoomMessage,
  unproxyAttachmentUrl,
} = await import("../main/agents/managed-agent-attachments.js");
const {
  executeManagedAgentRoomToolRequestWithTimeout,
} = await import("../main/agents/managed-agent-room-tools.js");
const { addLocalChatMessage } = await import("../main/rooms/messages/local-store.js");
const { saveAgentSession } = await import("../main/agents/state.js");

import type { DesktopRoomStorageState } from "../ipc-types.js";

function setupWorkerSession(): void {
  resetState();
  saveAgentSession({
    session_id: "agent_session_attachments",
    session_token: "secret_session_token",
    room_id: "room_1",
    session_kind: "worker",
    runtime: "codex:test",
    actor_label: "MapleRidge | EmmyMay's agent | Codex",
    agent_key: "EmmyMay/maple-ridge",
    agent_instance_id: "desktop-codex:test",
    display_name: "MapleRidge",
    owner_label: "EmmyMay",
    ide_label: "Codex",
    created_at: "2026-07-06T00:00:00.000Z",
    updated_at: "2026-07-06T00:00:00.000Z",
  });
}

function localStorage(roomIdentifier: string): DesktopRoomStorageState {
  return {
    roomIdentifier,
    defaultMode: "local",
    overrideMode: "local",
    effectiveMode: "local",
    isLocalRoom: true,
    localRoom: {
      roomIdentifier,
      displayName: "Local Room",
      cloudRoomIdentifier: null,
      publishStatus: "local_only",
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
      publishedAt: null,
      gitRoom: null,
    },
    databasePath: process.env.LETAGENTS_LOCAL_CHAT_DB ?? "",
    localFilesPath: join(tempDir, "files"),
  };
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("attachment descriptors mark images with a read hint and never inline bytes", () => {
  const descriptors = describeAgentMessageAttachments("msg_9", [
    {
      id: "att_1",
      file_name: "screenshot.png",
      mime_type: "image/png",
      size_bytes: 123,
      content_base64: PNG_BYTES.toString("base64"),
    },
    {
      id: "att_2",
      file_name: "notes.txt",
      mime_type: "text/plain",
      content_base64: Buffer.from("notes").toString("base64"),
    },
  ]);

  assert.deepEqual(descriptors[0], {
    id: "att_1",
    file_name: "screenshot.png",
    mime_type: "image/png",
    size_bytes: 123,
    image: true,
    read_tool: "read_message_attachment",
    read_arguments: { message_id: "msg_9", attachment_id: "att_1" },
  });
  assert.deepEqual(descriptors[1], {
    id: "att_2",
    file_name: "notes.txt",
    mime_type: "text/plain",
    size_bytes: null,
    image: false,
  });
  assert.ok(!JSON.stringify(descriptors).includes(PNG_BYTES.toString("base64")));
});

test("agent-readable messages replace attachment bytes with descriptors", () => {
  const readable = toAgentReadableRoomMessage({
    id: "msg_3",
    text: "see screenshot",
    attachments: [{
      id: "att_1",
      fileName: "screen.png",
      mimeType: "image/png",
      sizeBytes: 11,
      contentBase64: PNG_BYTES.toString("base64"),
    }],
  });
  assert.equal(readable.attachments[0]?.image, true);
  assert.ok(!("contentBase64" in (readable.attachments[0] as unknown as Record<string, unknown>)));
});

test("event prompt attachment lines describe images with fetch instructions", () => {
  const lines = describeDesktopEventMessageAttachments({
    id: "msg_12",
    attachments: [
      { id: "att_9", fileName: "error-dialog.png", mimeType: "image/png", sizeBytes: 245760 },
      { id: "att_10", fileName: "trace.log", mimeType: "text/plain", sizeBytes: 900 },
    ],
  });
  assert.equal(lines[0], "Attachments:");
  assert.match(lines[1] ?? "", /error-dialog\.png \(image\/png, 240 KB\)/);
  assert.match(lines[1] ?? "", /read_message_attachment/);
  assert.match(lines[1] ?? "", /"message_id":"msg_12","attachment_id":"att_9"/);
  assert.match(lines[2] ?? "", /trace\.log \(text\/plain, 900 B\)$/);
});

test("unproxyAttachmentUrl decodes the renderer proxy scheme and passes raw urls through", () => {
  const raw = "/rooms/room_1/attachments/att_1/download";
  const proxied = `letagents-attachment://download/${Buffer.from(raw, "utf8").toString("base64url")}`;
  assert.equal(unproxyAttachmentUrl(proxied), raw);
  assert.equal(unproxyAttachmentUrl(raw), raw);
});

test("materialized attachments are content-addressed, idempotent, and cleaned per session", () => {
  const first = materializeAgentSessionAttachment({
    sessionKey: "session/one",
    messageId: "msg_5",
    attachmentId: "att_5",
    fileName: "screen shot!.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
  const second = materializeAgentSessionAttachment({
    sessionKey: "session/one",
    messageId: "msg_5",
    attachmentId: "att_5",
    fileName: "screen shot!.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
  assert.equal(first, second);
  assert.ok(existsSync(first));
  assert.ok(first.endsWith(".png"));
  assert.deepEqual(readFileSync(first), PNG_BYTES);

  const unnamed = materializeAgentSessionAttachment({
    sessionKey: "session/one",
    messageId: "msg_6",
    attachmentId: "att_6",
    fileName: null,
    mimeType: "image/jpeg",
    buffer: PNG_BYTES,
  });
  assert.ok(unnamed.endsWith("attachment.jpg"));

  cleanupAgentSessionAttachments("session/one");
  assert.ok(!existsSync(first));
});

test("read_message_attachment room tool saves a local image and returns its path", async () => {
  setupWorkerSession();
  const roomIdentifier = "local_room_attachments";
  const message = await addLocalChatMessage(roomIdentifier, {
    sender: "EmmyMay",
    text: "This dialog keeps appearing",
    source: "browser",
    attachments: [
      {
        id: "att_image",
        file_name: "dialog.png",
        mime_type: "image/png",
        size_bytes: PNG_BYTES.byteLength,
        content_base64: PNG_BYTES.toString("base64"),
      },
      {
        id: "att_text",
        file_name: "notes.txt",
        mime_type: "text/plain",
        content_base64: Buffer.from("notes").toString("base64"),
      },
    ],
  });

  const result = await executeManagedAgentRoomToolRequestWithTimeout({
    session: {
      session_id: "live_session_attachments",
      room_id: roomIdentifier,
      room_identifier: roomIdentifier,
      agent_session_id: "agent_session_attachments",
    },
    storage: localStorage(roomIdentifier),
    request: {
      tool: "read_message_attachment",
      arguments: { message_id: message.id, attachment_id: "att_image" },
    },
  });

  assert.equal(result.ok, true);
  const data = (result as { data: Record<string, unknown> }).data;
  assert.equal(data.file_name, "dialog.png");
  assert.equal(data.mime_type, "image/png");
  assert.equal(data.size_bytes, PNG_BYTES.byteLength);
  const filePath = String(data.file_path);
  assert.ok(existsSync(filePath));
  assert.deepEqual(readFileSync(filePath), PNG_BYTES);

  const nonImage = await executeManagedAgentRoomToolRequestWithTimeout({
    session: {
      session_id: "live_session_attachments",
      room_id: roomIdentifier,
      room_identifier: roomIdentifier,
      agent_session_id: "agent_session_attachments",
    },
    storage: localStorage(roomIdentifier),
    request: {
      tool: "read_message_attachment",
      arguments: { message_id: message.id, attachment_id: "att_text" },
    },
  });
  assert.equal(nonImage.ok, false);
  assert.match((nonImage as { error: string }).error, /Only image attachments/);

  const missing = await executeManagedAgentRoomToolRequestWithTimeout({
    session: {
      session_id: "live_session_attachments",
      room_id: roomIdentifier,
      room_identifier: roomIdentifier,
      agent_session_id: "agent_session_attachments",
    },
    storage: localStorage(roomIdentifier),
    request: {
      tool: "read_message_attachment",
      arguments: { message_id: message.id, attachment_id: "att_missing" },
    },
  });
  assert.equal(missing.ok, false);
  assert.match((missing as { error: string }).error, /no attachment with this attachment_id/);

  cleanupAgentSessionAttachments("live_session_attachments");
});

test("read_messages room tool returns attachment descriptors instead of bytes", async () => {
  setupWorkerSession();
  const roomIdentifier = "local_room_attachment_listing";
  await addLocalChatMessage(roomIdentifier, {
    sender: "EmmyMay",
    text: "screenshot attached",
    source: "browser",
    attachments: [{
      id: "att_list",
      file_name: "screen.png",
      mime_type: "image/png",
      size_bytes: PNG_BYTES.byteLength,
      content_base64: PNG_BYTES.toString("base64"),
    }],
  });

  const result = await executeManagedAgentRoomToolRequestWithTimeout({
    session: {
      session_id: "live_session_attachments",
      room_id: roomIdentifier,
      room_identifier: roomIdentifier,
      agent_session_id: "agent_session_attachments",
    },
    storage: localStorage(roomIdentifier),
    request: { tool: "read_messages", arguments: { limit: 5 } },
  });

  assert.equal(result.ok, true);
  const serialized = JSON.stringify((result as { data: unknown }).data);
  assert.ok(!serialized.includes(PNG_BYTES.toString("base64")), "tool results must not inline attachment bytes");
  assert.match(serialized, /"read_tool":"read_message_attachment"/);
  assert.match(serialized, /"attachment_id":"att_list"/);
});

test("dropped attachments stored as file: urls resolve to the on-disk bytes, not the preview", async () => {
  setupWorkerSession();
  const roomIdentifier = "local_room_file_url_attachment";
  const fullImage = Buffer.concat([PNG_BYTES, Buffer.from("full-resolution")]);
  const stagedPath = join(tempDir, "staged-drop.png");
  writeFileSync(stagedPath, fullImage);
  const previewDataUrl = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

  const message = await addLocalChatMessage(roomIdentifier, {
    sender: "EmmyMay",
    text: "dropped a screenshot",
    source: "browser",
    attachments: [{
      id: "att_dropped",
      file_name: "staged-drop.png",
      mime_type: "image/png",
      size_bytes: fullImage.byteLength,
      url: pathToFileURL(stagedPath).toString(),
      download_url: pathToFileURL(stagedPath).toString(),
      data_url: previewDataUrl,
    }],
  });

  const result = await executeManagedAgentRoomToolRequestWithTimeout({
    session: {
      session_id: "live_session_file_url",
      room_id: roomIdentifier,
      room_identifier: roomIdentifier,
      agent_session_id: "agent_session_attachments",
    },
    storage: localStorage(roomIdentifier),
    request: {
      tool: "read_message_attachment",
      arguments: { message_id: message.id, attachment_id: "att_dropped" },
    },
  });

  assert.equal(result.ok, true);
  const data = (result as { data: Record<string, unknown> }).data;
  assert.deepEqual(
    readFileSync(String(data.file_path)),
    fullImage,
    "the on-disk file must win over the downscaled data_url preview",
  );
  cleanupAgentSessionAttachments("live_session_file_url");
});

test("oversized attachments are rejected from declared size before any read", async () => {
  setupWorkerSession();
  const roomIdentifier = "local_room_oversize_attachment";
  const message = await addLocalChatMessage(roomIdentifier, {
    sender: "EmmyMay",
    text: "huge image",
    source: "browser",
    attachments: [{
      id: "att_huge",
      file_name: "huge.png",
      mime_type: "image/png",
      size_bytes: 25 * 1024 * 1024,
      content_base64: PNG_BYTES.toString("base64"),
    }],
  });

  const result = await executeManagedAgentRoomToolRequestWithTimeout({
    session: {
      session_id: "live_session_oversize",
      room_id: roomIdentifier,
      room_identifier: roomIdentifier,
      agent_session_id: "agent_session_attachments",
    },
    storage: localStorage(roomIdentifier),
    request: {
      tool: "read_message_attachment",
      arguments: { message_id: message.id, attachment_id: "att_huge" },
    },
  });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /larger than the 10 MB/);
});

test("api downloads enforce the byte cap from headers and while streaming", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(new Blob([PNG_BYTES]), {
      status: 200,
      headers: { "Content-Length": String(20 * 1024 * 1024) },
    })) as typeof fetch;
    await assert.rejects(
      () => downloadApiAttachment("/rooms/r/attachments/a/download", { maxBytes: 10 * 1024 * 1024 }),
      /larger than the 10 MB/,
    );

    globalThis.fetch = (async () => {
      const chunk = new Uint8Array(64 * 1024);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent < 3 * 1024 * 1024; sent += chunk.byteLength) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      () => downloadApiAttachment("/rooms/r/attachments/a/download", { maxBytes: 1024 * 1024 }),
      /larger than the 1 MB/,
    );

    globalThis.fetch = (async () => new Response(new Blob([PNG_BYTES]), { status: 200 })) as typeof fetch;
    const buffer = await downloadApiAttachment("/rooms/r/attachments/a/download", { maxBytes: 1024 });
    assert.deepEqual(buffer, PNG_BYTES);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
