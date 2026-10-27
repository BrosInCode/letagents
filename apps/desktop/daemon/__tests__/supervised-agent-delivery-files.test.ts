import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderActionPort, ProviderRoomTurnRequest, RoomTurnFileAccess } from "../provider-action-port.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { RoomTurnAttachmentStager } from "../room-turn-attachments.js";
import { agent, provider, withAttachmentStager } from "./helpers/supervised-agent-delivery-fixture.js";

// Text files and PDFs, end to end through the delivery loop: a path the agent opens itself.

type Message = Record<string, unknown>;
const activate = { for_current_agent: { decision: "activate", reason: "mention" } };
const LOG = new TextEncoder().encode("step 1 ok\nstep 2 failed: exit 1\n");
const logMessage = (id: string, overrides: Message = {}): Message => ({ id, text: "the build log", sender: "Ada", thread_root_id: id,
  attachments: [{ id: "att_1", filename: "build.log", content_type: "text/plain", byte_size: LOG.byteLength }], ...overrides });
const ask = (id: string): Message => ({ id, text: "why did it fail?", sender: "Ada", thread_root_id: id, activation: activate });
const number = (id: unknown) => Number(String(id).slice(4));
const room = (messages: Message[]) => async ({ afterMessageId }: { afterMessageId: string | null }) =>
  ({ messages: messages.filter(message => afterMessageId === null || number(message.id) > number(afterMessageId)) });

function port(access: RoomTurnFileAccess, turns: Array<{ request: ProviderRoomTurnRequest; read: string | null }>) {
  return { ...provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.(`turn:${request.inboxItemId}`);
    // What the agent does with its own file tool.
    const path = request.attachments?.find(file => file.status === "file")?.file?.path;
    turns.push({ request, read: path ? await readFile(path, "utf8") : null });
    return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
  }), roomTurnImageDelivery: async () => "memory" as const, roomTurnFileAccess: async () => access } satisfies ProviderActionPort;
}

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "letagents-turn-files-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("a log on the message one before reaches the turn as a file the agent reads, downloaded once, gone after the turn", async () => {
  await withRoot(async (root) => {
    const messages: Message[] = [logMessage("msg_4"), ask("msg_5")];
    const turns: Array<{ request: ProviderRoomTurnRequest; read: string | null }> = [];
    let downloads = 0;
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const stagedRoot = join(root, "room-turn-attachments");
    const delivery = withAttachmentStager(store, port({ text: true, pdf: false }, turns), {
      poll: room(messages),
      downloadAttachment: async () => { downloads += 1; return LOG; },
      publish: async () => { throw new Error("no reply expected"); },
    }, new RoomTurnAttachmentStager(stagedRoot));
    try {
      await delivery.poll(agent);
      const [first] = turns;
      assert.equal(first?.read, new TextDecoder().decode(LOG), "the agent opens the staged copy");
      const note = first!.request.attachments![0]!;
      assert.deepEqual([note.status, note.origin?.messageId, note.file?.kind, note.file?.lines], ["file", "msg_4", "text", 2]);
      messages.push(ask("msg_6"));
      await delivery.poll(agent);
      assert.equal(turns[1]?.read, new TextDecoder().decode(LOG), "still in view, so given again");
      assert.equal(turns[1]?.request.attachments?.[0]?.file?.repeated, true);
      assert.equal(downloads, 1, "the kept copy serves the second turn");
      for (let attempt = 0; attempt < 50 && (await readdir(stagedRoot)).some(name => name.startsWith("turn-")); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.deepEqual((await readdir(stagedRoot)).filter(name => name.startsWith("turn-")), [], "each turn's copy is removed with its turn");
      const detail = await store.detail(agent.agentId, agent.roomId, "msg_5");
      assert.ok(!JSON.stringify(detail).includes("step 2 failed"), "the file's text is never saved with the turn");
    } finally { await delivery.fenceAndDrain(); await store.close(); }
  });
});

test("a guest agent and an agent that opens no files are told, and nothing is downloaded", async () => {
  await withRoot(async (root) => {
    for (const [subject, access] of [[{ ...agent, agentId: "supervised_rental_guest" }, { text: true, pdf: true }], [agent, null]] as const) {
      const turns: Array<{ request: ProviderRoomTurnRequest; read: string | null }> = [];
      let downloads = 0;
      const store = new SupervisedAgentInboxStore(join(root, `${subject.agentId}.sqlite`));
      const delivery = withAttachmentStager(store, port(access, turns), {
        poll: room([{ ...logMessage("msg_4"), activation: activate }]),
        downloadAttachment: async () => { downloads += 1; return LOG; },
        publish: async () => { throw new Error("no reply expected"); },
      }, new RoomTurnAttachmentStager(join(root, `${subject.agentId}-staged`)));
      try {
        await delivery.poll(subject);
        assert.deepEqual(turns[0]?.request.attachments?.map(file => file.status), ["cannot_read"], subject.agentId);
        assert.equal(downloads, 0);
      } finally { await delivery.fenceAndDrain(); await store.close(); }
    }
  });
});
