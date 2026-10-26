import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderActionPort, ProviderRoomTurnAttachment, ProviderRoomTurnRequest } from "../provider-action-port.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { RoomTurnAttachmentStager } from "../room-turn-attachments.js";
import { SupervisedRoomAuthorizationError } from "../supervised-agent-delivery.js";
import { agent, provider, STAGED_PNG, pngAttachment, withAttachmentStager } from "./helpers/supervised-agent-delivery-fixture.js";

// Images on recent messages before the activating one, end to end through the delivery loop.

type Message = Record<string, unknown>;
const activate = { for_current_agent: { decision: "activate", reason: "mention" } };
const shot = (id: string, attachment: string, overrides: Message = {}): Message => ({ id, text: "Here is the bug", sender: "Ada",
  thread_root_id: id, attachments: [pngAttachment(attachment)], ...overrides });
const ask = (id: string, overrides: Message = {}): Message => ({ id, text: "please fix this", sender: "Ada", thread_root_id: id,
  activation: activate, ...overrides });
const number = (id: unknown) => Number(String(id).slice(4));

/** A room whose poll returns its messages after the cursor, as the server does. */
function room(messages: Message[]) {
  return async ({ afterMessageId }: { afterMessageId: string | null }) =>
    ({ messages: messages.filter(message => afterMessageId === null || number(message.id) > number(afterMessageId)) });
}

async function withStore(run: (root: string, open: () => SupervisedAgentInboxStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "letagents-recent-images-"));
  const stores: SupervisedAgentInboxStore[] = [];
  try {
    await run(root, () => { const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite")); stores.push(store); return store; });
  } finally {
    for (const store of stores) await store.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

function recordingPort(delivery: "memory" | "file" | null, seen: ProviderRoomTurnRequest[], onTurn?: (request: ProviderRoomTurnRequest) => Promise<void>) {
  return { ...provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.(`turn:${request.inboxItemId}`);
    seen.push(request);
    await onTurn?.(request);
    return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
  }), roomTurnImageDelivery: async () => delivery } satisfies ProviderActionPort;
}

const summary = (files: ProviderRoomTurnAttachment[] | undefined) =>
  (files ?? []).map(file => [file.origin ? `${file.origin.messageId} by ${file.origin.sender}` : "source", file.status]);

test("the screenshot sent one message earlier reaches the agent once per conversation, also after a restart", async () => {
  await withStore(async (root, open) => {
    const messages: Message[] = [shot("msg_4", "att_1"), ask("msg_5")];
    const downloads: string[] = [];
    const seen: ProviderRoomTurnRequest[] = [];
    const contents: string[] = [];
    const http = {
      poll: room(messages),
      downloadAttachment: async (input: { messageId: string; attachmentId: string; bearer: string }) => {
        downloads.push(`${input.messageId}/${input.attachmentId} with ${input.bearer}`);
        return STAGED_PNG;
      },
      publish: async () => { throw new Error("no reply expected"); },
    };
    const port = recordingPort("file", seen, async (request) => {
      for (const file of request.attachments ?? []) if (file.image?.path) contents.push((await readFile(file.image.path)).toString("hex"));
    });
    const store = open();
    const delivery = withAttachmentStager(store, port, http, new RoomTurnAttachmentStager(join(root, "room-turn-attachments")));
    try {
      await delivery.poll(agent);
      assert.deepEqual(summary(seen[0]?.attachments), [["msg_4 by Ada", "image"]]);
      assert.deepEqual(downloads, ["msg_4/att_1 with memory"], "the daemon downloads it with the worker bearer");
      assert.deepEqual(contents, [Buffer.from(STAGED_PNG).toString("hex")], "the provider reads the staged copy");
      messages.push(ask("msg_6"));
      await delivery.poll(agent);
      assert.deepEqual(summary(seen[1]?.attachments), [["msg_4 by Ada", "earlier_turn"]]);
      assert.equal(downloads.length, 1, "the same conversation is not sent it again");
      const detail = await store.detail(agent.agentId, agent.roomId, "msg_5");
      assert.equal(JSON.stringify(detail.prepared_context).includes("room_files"), false, "the Inspector's room context stays text");
    } finally { await delivery.fenceAndDrain(); await store.close(); }

    // A restarted daemon reads what the conversation has from its own state.
    const reopened = open();
    const restarted = withAttachmentStager(reopened, port, http, new RoomTurnAttachmentStager(join(root, "room-turn-attachments")));
    try {
      messages.push(ask("msg_7"));
      await restarted.poll(agent);
      assert.deepEqual(summary(seen[2]?.attachments), [["msg_4 by Ada", "earlier_turn"]]);
      assert.equal(downloads.length, 1);
      // A new conversation cannot see what the old one received, so it is offered the image again.
      messages.push(ask("msg_8"));
      const fresh = { ...agent, providerContinuationId: "thread-2", handle: { ...agent.handle, providerContinuationId: "thread-2" } };
      await restarted.poll(fresh);
      assert.deepEqual(summary(seen[3]?.attachments), [["msg_4 by Ada", "image"]]);
      assert.equal(downloads.length, 2);
    } finally { await restarted.fenceAndDrain(); }
  });
});

test("a thread reply gets its root's image through one thread read when the room context lacks the root", async () => {
  await withStore(async (root, open) => {
    const threads: Message[] = [];
    const seen: ProviderRoomTurnRequest[] = [];
    const store = open();
    const delivery = withAttachmentStager(store, recordingPort("memory", seen), {
      poll: room([ask("msg_9", { thread_root_id: "msg_2" })]),
      thread: async (input) => {
        threads.push({ ...input, signal: undefined });
        return { root: shot("msg_2", "att_1", { sender: "Grace" }), replies: [shot("msg_3", "att_2", { thread_root_id: "msg_2" })] };
      },
      downloadAttachment: async () => STAGED_PNG,
      publish: async () => { throw new Error("no reply expected"); },
    }, new RoomTurnAttachmentStager(join(root, "room-turn-attachments")));
    try {
      await delivery.poll(agent);
      assert.deepEqual(threads, [{ roomId: "room", apiUrl: agent.apiUrl, bearer: "memory", rootMessageId: "msg_2",
        beforeMessageId: "msg_9", limit: 5, signal: undefined }]);
      assert.deepEqual(summary(seen[0]?.attachments), [["msg_2 by Grace", "image"], ["msg_3 by Ada", "image"]]);
      assert.equal(seen[0]?.attachments?.[0]?.origin?.inThread, true);
      assert.deepEqual(seen[0]?.attachments?.[0]?.image?.data, STAGED_PNG, "memory delivery gets the bytes, not a file");
    } finally { await delivery.fenceAndDrain(); }
  });
});

test("a thread whose root is in the room context is not read again, and a refused thread read is not a room refusal", async () => {
  await withStore(async (root, open) => {
    let threadReads = 0;
    const seen: ProviderRoomTurnRequest[] = [];
    const messages: Message[] = [shot("msg_2", "att_1"), ask("msg_3", { thread_root_id: "msg_2" }), ask("msg_4", { thread_root_id: "msg_1" })];
    const store = open();
    const delivery = withAttachmentStager(store, recordingPort("memory", seen), {
      poll: room(messages),
      thread: async () => { threadReads += 1; throw new SupervisedRoomAuthorizationError("Room thread read failed with HTTP 403.", 403); },
      downloadAttachment: async () => STAGED_PNG,
      publish: async () => { throw new Error("no reply expected"); },
    }, new RoomTurnAttachmentStager(join(root, "room-turn-attachments")));
    try {
      await delivery.poll(agent);
      assert.deepEqual(summary(seen[0]?.attachments), [["msg_2 by Ada", "image"]]);
      assert.equal(threadReads, 1, "only msg_4, whose root msg_1 the context lacks, reads its thread");
      assert.deepEqual(summary(seen[1]?.attachments), [], "msg_4's thread could not be read, so it carries nothing");
      assert.equal(delivery.roomRefusesAccess(agent.agentId), false);
      assert.equal((await store.receipts(agent.agentId)).every(receipt => receipt.state === "acknowledged_no_reply"), true);
    } finally { await delivery.fenceAndDrain(); }
  });
});

test("an agent that cannot see images reads no thread, downloads nothing and is told so", async () => {
  await withStore(async (root, open) => {
    let threadReads = 0;
    let downloads = 0;
    const seen: ProviderRoomTurnRequest[] = [];
    const store = open();
    const delivery = withAttachmentStager(store, recordingPort(null, seen), {
      poll: room([shot("msg_4", "att_1"), ask("msg_5"), ask("msg_9", { thread_root_id: "msg_1" })]),
      thread: async () => { threadReads += 1; return null; },
      downloadAttachment: async () => { downloads += 1; return STAGED_PNG; },
      publish: async () => { throw new Error("no reply expected"); },
    }, new RoomTurnAttachmentStager(join(root, "room-turn-attachments")));
    try {
      await delivery.poll(agent);
      assert.deepEqual(summary(seen[0]?.attachments), [["msg_4 by Ada", "provider_unsupported"]]);
      assert.equal(threadReads, 0);
      assert.equal(downloads, 0);
    } finally { await delivery.fenceAndDrain(); }
  });
});

test("images reach the record only when the provider answered the turn that carried them; recovery never downloads", async () => {
  await withStore(async (root, open) => {
    const messages: Message[] = [shot("msg_4", "att_1"), ask("msg_5")];
    let downloads = 0;
    const statuses: unknown[] = [];
    const recoveries: ProviderRoomTurnRequest[] = [];
    let first = true;
    const port = { ...provider(async (_handle, request, options) => {
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.(`turn:${request.inboxItemId}`);
      statuses.push(summary(request.attachments));
      if (first) {
        first = false;
        // What a detached observation does: the native turn may go on, with no answer for this delivery.
        throw new Error("Codex room-turn observation detached.");
      }
      return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
    }, async (_handle, request) => {
      recoveries.push(request as unknown as ProviderRoomTurnRequest);
      return { turnId: request.providerTurnId, outcome: "no_reply", text: null, evidence: "transcript" };
    }), roomTurnImageDelivery: async () => "memory" as const } satisfies ProviderActionPort;
    const store = open();
    const delivery = withAttachmentStager(store, port, {
      poll: room(messages),
      downloadAttachment: async () => { downloads += 1; return STAGED_PNG; },
      publish: async () => { throw new Error("no reply expected"); },
    }, new RoomTurnAttachmentStager(join(root, "room-turn-attachments")));
    try {
      await delivery.poll(agent);
      await delivery.poll(agent);
      assert.equal(recoveries.length, 1, "the detached turn is recovered");
      assert.equal((recoveries[0] as unknown as Record<string, unknown>).attachments, undefined);
      assert.equal(downloads, 1, "the recovery downloads nothing");
      messages.push(ask("msg_6"));
      await delivery.poll(agent);
      assert.deepEqual(statuses.at(-1), [["msg_4 by Ada", "image"]], "an unanswered turn did not count as received");
      assert.equal(downloads, 2);
    } finally { await delivery.fenceAndDrain(); }
  });
});

test("a failure to remember the images never fails the turn", async () => {
  await withStore(async (root, open) => {
    const seen: ProviderRoomTurnRequest[] = [];
    const store = open();
    store.recordRoomTurnFiles = async () => { throw new Error("disk full"); };
    const delivery = withAttachmentStager(store, recordingPort("memory", seen), {
      poll: room([shot("msg_4", "att_1"), ask("msg_5")]),
      downloadAttachment: async () => STAGED_PNG,
      publish: async () => { throw new Error("no reply expected"); },
    }, new RoomTurnAttachmentStager(join(root, "room-turn-attachments")));
    try {
      await delivery.poll(agent);
      assert.deepEqual(summary(seen[0]?.attachments), [["msg_4 by Ada", "image"]]);
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_no_reply");
    } finally { await delivery.fenceAndDrain(); }
  });
});
