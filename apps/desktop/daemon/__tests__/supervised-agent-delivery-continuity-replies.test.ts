import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SupervisedAgentDelivery, supervisedReplyTargetForSourceMessage } from "../supervised-agent-delivery.js";
import { SupervisedAgentInboxStore } from "../supervised-agent-inbox-store.js";
import { ReplyAttachmentSpool } from "../reply-attachment-spool.js";
import {
  agent,
  currentAuthority,
  provider,
  ingest,
  continuityTask,
  SHORT_FAULT_WAITS,
  STOPPED_AFTER_THREE,
  recordThreadIntent,
  recordReplyIntent,
} from "./helpers/supervised-agent-delivery-fixture.js";

test("task continuity survives restart after native failure, preserves files and deduplicates completed effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-restart-"));
  const path = join(root, "state.sqlite");
  let store = new SupervisedAgentInboxStore(path);
  const effectRequest = { agent_id: agent.agentId, room_id: agent.roomId, execution_generation_id: "generation-1",
    provider_turn_id: "failed-turn", work_attempt_id: "attempt", current_execution_generation_id: "generation-2",
    provider_continuation_id: "thread", mcp_request_id: "publish-pr", tool_name: "publish_room_artifact",
    request: { url: "https://github.com/example/repo/pull/1" }, mutation: true };
  const http = { poll: async () => ({}), ownedTasks: async () => [continuityTask],
    publish: async () => ({ roomId: agent.roomId, messageId: "published" }) };
  let runs = 0;
  let delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    runs++;
    await options?.beforeNativeDispatch?.();
    await options?.checkpointTurnStarted?.("failed-turn");
    await writeFile(join(root, "work.txt"), "partial implementation\n");
    // An already executed external mutation has its durable receipt before the provider fails.
    const db = new DatabaseSync(path);
    db.prepare(`INSERT INTO supervised_agent_effects
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      VALUES ('effect',?,?,?,?,?,?,?,1,'completed',?,NULL,?,?)`).run(agent.agentId, agent.roomId, "generation-1",
      "failed-turn", effectRequest.mcp_request_id, effectRequest.tool_name, JSON.stringify(effectRequest.request),
      JSON.stringify({ artifact_id: "pr-1" }), new Date().toISOString(), new Date().toISOString());
    db.close();
    const failed = { turnId: "failed-turn", providerContinuationId: "thread", outcome: "failed" as const,
      text: null, evidence: "stream" as const, error: "HTTP 503 unavailable" };
    await options?.checkpointTerminalResult?.(failed);
    delivery.fence(); // Crash window: native failure is saved, child continuation does not yet exist.
    return failed;
  }), http, currentAuthority, 0);
  try {
    await ingest(store);
    await delivery.pump(agent);
    await delivery.fenceAndDrain(); await store.close();
    store = new SupervisedAgentInboxStore(path);
    const afterRestart = { ...agent, executionGenerationId: "generation-2", daemonGeneration: 2 };
    delivery = new SupervisedAgentDelivery(store, provider(async (handle, request, options) => {
      runs++;
      assert.equal(handle.providerContinuationId, "thread");
      assert.equal(request.activation.task_continuity !== undefined, true);
      assert.equal(await readFile(join(root, "work.txt"), "utf8"), "partial implementation\n");
      const replay = await store.prepareEffect(effectRequest);
      assert.equal(replay.created, false);
      assert.equal(replay.effect.state, "completed");
      assert.deepEqual(replay.effect.result, { artifact_id: "pr-1" });
      await options?.beforeNativeDispatch?.();
      await options?.checkpointTurnStarted?.("new-continuation");
      await writeFile(join(root, "work.txt"), "partial implementation\nremaining implementation\n");
      return { turnId: "new-continuation", outcome: "reply", text: "Finished the existing task." };
    }, async () => { throw new Error("The failed native turn must never be replayed or reattached."); }), http, currentAuthority, 0);
    await delivery.pump(afterRestart);
    await delivery.pump(afterRestart);
    assert.equal(runs, 2);
    assert.equal(await readFile(join(root, "work.txt"), "utf8"), "partial implementation\nremaining implementation\n");
    assert.equal((await store.cursor(agent.agentId))?.last_observed_message_id, "1");
    const receipts = await store.receipts(agent.agentId);
    assert.deepEqual(receipts.map(r => r.state), ["acknowledged_failed", "acknowledged"]);
    assert.equal((await store.taskContinuation(receipts[1]!.inbox_item_id))?.agentSessionId, "session-1");
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("recovering a failed turn under a replacement worker session cannot inherit its task", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-recovered-owner-"));
  const path = join(root, "state.sqlite"); let store = new SupervisedAgentInboxStore(path);
  let nativeStarts = 0; let ownershipReads = 0;
  const http = { poll: async () => ({}), publish: async () => {},
    ownedTasks: async () => { ownershipReads++; return [continuityTask]; } };
  let delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    await options?.beforeNativeDispatch?.(); nativeStarts++;
    await options?.checkpointTurnStarted?.("old-turn");
    delivery.fence();
    return { turnId: "old-turn", outcome: "unreadable", text: null, evidence: "none" };
  }), http, currentAuthority, 0);
  try {
    await ingest(store); await delivery.pump(agent);
    await delivery.fenceAndDrain(); await store.close(); store = new SupervisedAgentInboxStore(path);
    delivery = new SupervisedAgentDelivery(store, provider(async () => {
      nativeStarts++; throw new Error("must not run another native turn");
    }, async () => ({ turnId: "old-turn", providerContinuationId: "thread", outcome: "failed", text: null,
      evidence: "transcript", error: "HTTP 503" })), http, currentAuthority, 0);
    await delivery.pump({ ...agent, daemonGeneration: 2, executionGenerationId: "generation-2", agentSessionId: "replacement-worker" });
    assert.equal(nativeStarts, 1);
    assert.equal(ownershipReads, 0);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged_failed");
    assert.equal(await store.head(agent.agentId), null);
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("task continuity persists its delay and three-continuation budget across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-budget-"));
  const path = join(root, "state.sqlite");
  let now = Date.parse("2026-09-09T00:00:00Z");
  let store = new SupervisedAgentInboxStore(path, () => new Date(now).toISOString());
  let runs = 0;
  const port = provider(async (_handle, _request, options) => {
    await options?.beforeNativeDispatch?.();
    const turnId = `failed-${++runs}`;
    await options?.checkpointTurnStarted?.(turnId);
    return { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", error: "HTTP 429 rate limit" };
  });
  const http = { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] };
  let delivery: SupervisedAgentDelivery;
  const makeDelivery = () => new SupervisedAgentDelivery(store, port, http, currentAuthority, 1, async () => {}, async () => { delivery.fence(); });
  delivery = makeDelivery();
  try {
    await ingest(store);
    for (let expected = 1; expected <= 4; expected++) {
      await delivery.pump({ ...agent, daemonGeneration: expected });
      assert.equal(runs, expected);
      const head = (await store.head(agent.agentId))!;
      if (expected < 4) {
        const delay = SHORT_FAULT_WAITS[expected - 1]!;
        assert.equal(head.next_attempt_at_ms, now + delay);
        await delivery.fenceAndDrain(); await store.close();
        store = new SupervisedAgentInboxStore(path, () => new Date(now).toISOString());
        assert.equal(await store.claimHead(agent.agentId), null, "restart cannot bypass the persisted due time");
        now += delay;
        delivery = makeDelivery();
      } else {
        assert.equal(head.state, "blocked");
        assert.equal(head.last_error, STOPPED_AFTER_THREE);
        await delivery.pump(agent);
        assert.equal(runs, 4, "the original turn plus three automatic continuations is the hard bound");
      }
    }
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

for (const [error, explanation] of [["HTTP 402 insufficient credits", /credit/], ["HTTP 401 unauthorized", /authentication/],
  ["HTTP 429 insufficient_quota", /credit/], ["Unclassified native failure", /could not be established/]] as const) {
  test(`task continuity pauses ${error} and resumes existing work through Retry delivery`, async () => {
    const root = await mkdtemp(join(tmpdir(), "continuity-account-"));
    const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
    let runs = 0;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.();
      const turnId = `turn-${++runs}`;
      await options?.checkpointTurnStarted?.(turnId);
      return runs === 1 ? { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", error }
        : { turnId, outcome: "no_reply", text: null };
    }), { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] }, currentAuthority, 0);
    try {
      await ingest(store); await delivery.pump(agent);
      const head = (await store.head(agent.agentId))!;
      assert.equal(runs, 1); assert.equal(head.state, "blocked");
      assert.match(head.last_error!, explanation); assert.match(head.last_error!, /Retry delivery/);
      await store.retryBlocked(head.inbox_item_id); await delivery.pump(agent);
      assert.equal(runs, 2);
      assert.equal(await store.head(agent.agentId), null);
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("continuation survives an unavailable ownership snapshot and drops only tasks no longer owned", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-snapshot-"));
  const store = new SupervisedAgentInboxStore(join(root, "state.sqlite"));
  const second = { ...continuityTask, id: "task_2", leaseId: "lease-2" };
  let owned = [continuityTask, second]; let unavailable = true; let runs = 0;
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request, options) => {
    await options?.beforeNativeDispatch?.();
    const turnId = `turn-${++runs}`;
    await options?.checkpointTurnStarted?.(turnId);
    if (runs === 1) return { turnId, providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", error: "HTTP 503" };
    assert.match(JSON.stringify(request.sourceMessage), /task_2/);
    assert.doesNotMatch(JSON.stringify(request.sourceMessage), /task_1/);
    return { turnId, outcome: "no_reply", text: null };
  }), { poll: async () => ({}), publish: async () => {}, ownedTasks: async input => {
    assert.ok(input.heldBefore);
    if (unavailable) throw new Error("room offline");
    return owned;
  } }, currentAuthority, 0);
  try {
    await ingest(store); await delivery.pump(agent);
    const head = (await store.head(agent.agentId))!;
    assert.equal((await store.taskContinuation(head.inbox_item_id))?.tasks, null);
    unavailable = false;
    await store.retryBlocked(head.inbox_item_id);
    await store.refreshTaskContinuationSnapshot(head.inbox_item_id, owned);
    owned = [second];
    await delivery.pump(agent);
    assert.equal(runs, 2);
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

for (const changed of ["session", "workAttempt", "conversation", "lease", "epoch", "finished", "agentInstance"] as const) {
  test(`task continuity refuses changed ${changed} after restart`, async () => {
    const root = await mkdtemp(join(tmpdir(), "continuity-owner-"));
    const path = join(root, "state.sqlite"); let store = new SupervisedAgentInboxStore(path);
    let runs = 0; let owned = [continuityTask];
    const port = provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.(); runs++;
      await options?.checkpointTurnStarted?.("failed");
      return { turnId: "failed", providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", error: "HTTP 402" };
    });
    const http = { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => owned };
    let delivery = new SupervisedAgentDelivery(store, port, http, currentAuthority, 0);
    try {
      await ingest(store); await delivery.pump(agent);
      const head = (await store.head(agent.agentId))!;
      await store.retryBlocked(head.inbox_item_id);
      await delivery.fenceAndDrain(); await store.close(); store = new SupervisedAgentInboxStore(path);
      if (changed === "lease") owned = [{ ...continuityTask, leaseId: "new-lease" }];
      if (changed === "epoch") owned = [{ ...continuityTask, epoch: 3 }];
      if (changed === "finished") owned = [];
      const nextAgent = { ...agent,
        ...(changed === "session" ? { agentSessionId: "session-2" } : {}),
        ...(changed === "workAttempt" ? { workAttemptId: "attempt-2" } : {}),
        ...(changed === "conversation" ? { providerContinuationId: "thread-2" } : {}),
        ...(changed === "agentInstance" ? { agentId: "another-stone" } : {}) };
      delivery = new SupervisedAgentDelivery(store, port, http, currentAuthority, 0);
      await delivery.pump(nextAgent);
      assert.equal(runs, 1);
      owned = [{ ...continuityTask, id: "task-new" }];
      await delivery.pump(nextAgent);
      assert.equal(runs, 1, "an old failure cannot acquire subsequently assigned work");
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("an uncertain mutation prevents automatic continuation across restart without blocking new instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-uncertain-"));
  const path = join(root, "state.sqlite"); let store = new SupervisedAgentInboxStore(path);
  let runs = 0;
  const port = provider(async (_handle, _request, options) => {
    await options?.beforeNativeDispatch?.(); runs++;
    await options?.checkpointTurnStarted?.("failed");
    const db = new DatabaseSync(path);
    db.prepare(`INSERT INTO supervised_agent_effects
      (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
      VALUES ('effect',?,?,?,'failed','request','publish_room_artifact','{}',1,'executing',NULL,NULL,?,?)`)
      .run(agent.agentId, agent.roomId, "generation-1", new Date().toISOString(), new Date().toISOString()); db.close();
    return { turnId: "failed", providerContinuationId: "thread", outcome: "failed", text: null, evidence: "stream", error: "HTTP 503" };
  });
  const http = { poll: async () => ({}), publish: async () => {}, ownedTasks: async () => [continuityTask] };
  let delivery = new SupervisedAgentDelivery(store, port, http, currentAuthority, 0);
  try {
    await ingest(store); await delivery.pump(agent);
    assert.equal(await store.head(agent.agentId), null);
    const receipt = (await store.receipts(agent.agentId))[0]!;
    assert.equal(receipt.state, "acknowledged_failed"); assert.match(receipt.last_error!, /uncertain result/);
    await delivery.fenceAndDrain(); await store.close(); store = new SupervisedAgentInboxStore(path);
    delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.beforeNativeDispatch?.(); runs++;
      await options?.checkpointTurnStarted?.("human-follow-up");
      return { turnId: "human-follow-up", outcome: "no_reply", text: null };
    }), http, currentAuthority, 0);
    await delivery.pump(agent);
    assert.equal(runs, 1);
    await ingest(store, "2"); await delivery.pump(agent);
    assert.equal(runs, 2, "the uncertain result cannot silently replay work or deadlock later human instructions");
    assert.equal(await store.head(agent.agentId), null);
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("supervised reply targets inherit true threads but not top-level quote replies", () => {
  assert.deepEqual(
    supervisedReplyTargetForSourceMessage({
      id: "msg_45",
      reply_to: { id: "msg_44" },
      thread_root_id: "msg_44",
      thread: { root_message_id: "msg_44", is_thread_reply: true },
    }),
    { replyTo: "msg_45", threadRootId: "msg_44" },
  );
  assert.deepEqual(
    supervisedReplyTargetForSourceMessage({
      id: "msg_49",
      reply_to: { id: "msg_48" },
      thread_root_id: "msg_49",
      thread: { root_message_id: "msg_49", is_thread_reply: false },
    }),
    { replyTo: null, threadRootId: null },
  );
});

test("reply attachments are uploaded with the worker's bearer just before the reply, and a file that cannot be uploaded never blocks it", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-reply-attachments-"));
  const path = join(root, "state.sqlite");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "result.png"), "png bytes");
  await writeFile(join(workspace, "build.log"), "log lines");
  const spool = new ReplyAttachmentSpool(join(root, "spool"));
  const store = new SupervisedAgentInboxStore(path);
  const staged: Array<{ fileName: string; mimeType: string; bytes: string; bearer: string }> = [];
  const publications: Array<{ text: string; attachments: Array<{ upload_id: string }> | null }> = [];
  const http = {
    poll: async () => ({}),
    stageAttachment: async (input: { fileName: string; mimeType: string; bytes: Uint8Array; bearer: string }) => {
      staged.push({ fileName: input.fileName, mimeType: input.mimeType, bytes: Buffer.from(input.bytes).toString(), bearer: input.bearer });
      if (input.fileName === "build.log") throw new Error("Supervised attachment staging failed with HTTP 500.");
      return { uploadId: `upl_${staged.length}` };
    },
    publish: async (input: { text: string; roomId: string; attachments?: Array<{ upload_id: string }> }) => {
      publications.push({ text: input.text, attachments: input.attachments ?? null });
      return { messageId: "msg_81", roomId: input.roomId };
    },
  };
  let inboxItemId = "";
  const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
    await options?.checkpointTurnStarted?.("native-turn");
    // What the coordinator journals after it copied the files at call time.
    const recorded = await spool.snapshot({ workspacePath: workspace, inboxItemId, agentId: agent.agentId,
      providerTurnId: "native-turn", mcpRequestId: "set_reply_attachments-choice", files: ["result.png", "build.log"] });
    await recordReplyIntent(path, store, "native-turn", "set_reply_attachments", recorded);
    await writeFile(join(workspace, "result.png"), "edited after the call");
    return { turnId: "native-turn", outcome: "reply", text: "Here is the new layout." };
  }), http, currentAuthority, 0,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, spool);
  try {
    const [item] = await store.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: "msg_80",
      messages: [{ source_message_id: "msg_80", source_message: { id: "msg_80", text: "Show me the layout" }, activation: {} }] });
    inboxItemId = item!.inbox_item_id;
    await delivery.pump(agent);
    assert.deepEqual(staged, [
      { fileName: "result.png", mimeType: "image/png", bytes: "png bytes", bearer: agent.bearer },
      { fileName: "build.log", mimeType: "application/octet-stream", bytes: "log lines", bearer: agent.bearer },
      { fileName: "build.log", mimeType: "application/octet-stream", bytes: "log lines", bearer: agent.bearer },
    ], "a failed upload is retried once");
    assert.deepEqual(publications, [{
      text: "Here is the new layout.\n\n(Could not attach: build.log)",
      attachments: [{ upload_id: "upl_1" }],
    }]);
    assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
    assert.deepEqual(await readdir(join(root, "spool")), [], "a published reply's copies are removed");
  } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("staged reply attachments are discarded when the post fails or the lane loses the reply, and retried uploads still attach", async () => {
  for (const ending of ["post_fails", "authority_lost"] as const) {
    const root = await mkdtemp(join(tmpdir(), "letagents-reply-attachment-discard-"));
    const path = join(root, "state.sqlite");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "result.png"), "png bytes");
    const spool = new ReplyAttachmentSpool(join(root, "spool"));
    const store = new SupervisedAgentInboxStore(path);
    let stageCalls = 0;
    let ownsLane = true;
    const discarded: string[] = [];
    const posted: Array<Array<{ upload_id: string }> | null> = [];
    const http = {
      poll: async () => ({}),
      stageAttachment: async () => {
        stageCalls++;
        if (stageCalls === 1) throw new Error("Supervised attachment staging failed with HTTP 503.");
        if (ending === "authority_lost") ownsLane = false;
        return { uploadId: `upl_${stageCalls}` };
      },
      discardAttachment: async (input: { uploadId: string }) => { discarded.push(input.uploadId); },
      publish: async (input: { roomId: string; attachments?: Array<{ upload_id: string }> }) => {
        posted.push(input.attachments ?? null);
        if (ending === "post_fails") throw new Error("Room publication failed with HTTP 500.");
        return { messageId: "msg_91", roomId: input.roomId };
      },
    };
    let inboxItemId = "";
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.checkpointTurnStarted?.("native-turn");
      const recorded = await spool.snapshot({ workspacePath: workspace, inboxItemId, agentId: agent.agentId,
        providerTurnId: "native-turn", mcpRequestId: "set_reply_attachments-choice", files: ["result.png"] });
      await recordReplyIntent(path, store, "native-turn", "set_reply_attachments", recorded);
      return { turnId: "native-turn", outcome: "reply", text: "Done." };
    }), http, async () => ownsLane, 0,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, spool);
    try {
      const [item] = await store.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: "msg_90",
        messages: [{ source_message_id: "msg_90", source_message: { id: "msg_90", text: "Show me" }, activation: {} }] });
      inboxItemId = item!.inbox_item_id;
      await delivery.pump(agent);
      assert.equal(stageCalls >= 2, true, ending);
      assert.equal(discarded.includes("upl_2"), true, `${ending}: the unused upload is discarded`);
      if (ending === "post_fails") assert.deepEqual(posted[0], [{ upload_id: "upl_2" }], "the retried upload was attached");
      else assert.deepEqual(posted, [], "a lane that lost the reply posts nothing");
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("an intercepted thread choice survives publication failure and restart without another provider turn", async () => {
  for (const { toolName, effectState, existingRoot } of [
    ...["send_thread_message", "send_message"].flatMap(toolName => ["prepared", "failed"].map(effectState => ({ toolName, effectState, existingRoot: null }))),
    { toolName: "set_reply_thread", effectState: "completed", existingRoot: null },
    { toolName: "set_reply_thread", effectState: "completed", existingRoot: "msg_70" },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "letagents-thread-intent-"));
    const path = join(root, "state.sqlite");
    let store = new SupervisedAgentInboxStore(path);
    let runs = 0;
    let ownsLane = true;
    const publications: Array<{ clientMessageId: string; replyTo: string | null; threadRootId: string | null }> = [];
    const http = {
      poll: async () => ({}),
      publish: async (input: { clientMessageId: string; roomId: string; replyTo: string | null; threadRootId: string | null }) => {
        publications.push({ clientMessageId: input.clientMessageId, replyTo: input.replyTo, threadRootId: input.threadRootId });
        if (publications.length === 1) { ownsLane = false; throw new Error("publication acknowledgement lost during handoff"); }
        return { messageId: "published", roomId: input.roomId };
      },
    };
    let delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      runs++;
      await options?.checkpointTurnStarted?.("native-turn");
      if (toolName === "set_reply_thread") {
        await recordThreadIntent(path, store, "native-turn");
      } else {
        // The coordinator retains the intercepted request before returning USE_FINAL_ANSWER.
        const db = new DatabaseSync(path);
        try {
          db.prepare(`INSERT INTO supervised_agent_effects
            (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
            VALUES ('thread-choice',?,?,?,'native-turn','request',?,?,1,?,NULL,NULL,?,?)`)
            .run(agent.agentId, agent.roomId, "generation-1", toolName,
              JSON.stringify({ thread_parent_id: "msg_72", text: "draft" }), effectState, new Date().toISOString(), new Date().toISOString());
        } finally { db.close(); }
      }
      return { turnId: "native-turn", outcome: "reply", text: "final answer" };
    }), http, async () => ownsLane, 0);
    try {
      await store.ingestPoll({ agent_id: agent.agentId, room_id: agent.roomId, last_observed_message_id: "msg_72",
        messages: [{ source_message_id: "msg_72", source_message: { id: "msg_72", thread_root_id: existingRoot }, activation: {} }] });
      await delivery.pump(agent);
      assert.equal(publications.length, 1);
      assert.deepEqual(publications[0], {
        clientMessageId: "supervised-room:stone:room:msg_72:reply:v1", replyTo: "msg_72", threadRootId: existingRoot ?? "msg_72",
      });
      await delivery.fenceAndDrain(); await store.close();
      store = new SupervisedAgentInboxStore(path);
      ownsLane = true;
      delivery = new SupervisedAgentDelivery(store, provider(async () => {
        runs++; throw new Error("must not rerun the provider");
      }), http, currentAuthority, 0);
      await delivery.pump(agent);
      assert.equal(runs, 1);
      assert.deepEqual(publications, [publications[0], publications[0]]);
      assert.equal((await store.receipts(agent.agentId))[0]?.state, "acknowledged");
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("unrelated or non-thread message effects cannot redirect the daemon's activating reply", async () => {
  for (const variation of ["agent", "room", "generation", "turn", "parent", "quote", "tool", "executing", "completed", "uncertain"] as const) {
    const root = await mkdtemp(join(tmpdir(), "letagents-thread-fence-"));
    const path = join(root, "state.sqlite");
    const store = new SupervisedAgentInboxStore(path);
    let published = false;
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, _request, options) => {
      await options?.checkpointTurnStarted?.("native-turn");
      const db = new DatabaseSync(path);
      try {
        db.prepare(`INSERT INTO supervised_agent_effects
          (effect_id,agent_id,room_id,execution_generation_id,provider_turn_id,mcp_request_id,tool_name,request_json,mutation,state,result_json,error,created_at,updated_at)
          VALUES ('other-effect',?,?,?,?,'request',?,?,1,?,NULL,NULL,?,?)`)
          .run(variation === "agent" ? "other-agent" : agent.agentId,
            variation === "room" ? "other-room" : agent.roomId,
            variation === "generation" ? "old-generation" : "generation-1",
            variation === "turn" ? "other-turn" : "native-turn",
            variation === "tool" ? "publish_room_artifact" : "send_message",
            JSON.stringify(variation === "quote" ? { reply_to: "msg_72" }
              : { thread_parent_id: variation === "parent" ? "msg_71" : "msg_72" }),
            ["executing", "completed", "uncertain"].includes(variation) ? variation : "prepared",
            new Date().toISOString(), new Date().toISOString());
      } finally { db.close(); }
      return { turnId: "native-turn", outcome: "reply", text: "final answer" };
    }), {
      poll: async () => ({}),
      publish: async input => {
        assert.equal(input.replyTo, null, variation);
        assert.equal(input.threadRootId, null, variation);
        published = true;
        return { messageId: "published", roomId: input.roomId };
      },
    }, currentAuthority, 0);
    try {
      await ingest(store, "msg_72"); await delivery.pump(agent);
      assert.equal(published, true, variation);
    } finally { await delivery.fenceAndDrain(); await store.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("worker-authenticated activation ingress deduplicates replay and publishes one bounded reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-"));
  try {
    const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
    const polls: unknown[] = [];
    const published: Array<{ clientMessageId: string; replyTo: string | null; threadRootId: string | null }> = [];
    const delivery = new SupervisedAgentDelivery(store, provider(async (_handle, request) => ({ turnId: `turn:${request.inboxItemId}`, outcome: "reply", text: "hello" })), {
      poll: async (input) => { polls.push(input); return { messages: [{ id: "1", thread_root_id: "root", thread: { root_message_id: "root", is_thread_reply: true }, activation: { for_current_agent: { decision: "activate", reason: "server" } }, text: "hi" }, { id: "2", text: "ignored" }] }; },
      publish: async (input) => {
        published.push({ clientMessageId: input.clientMessageId, replyTo: input.replyTo, threadRootId: input.threadRootId });
        return { messageId: `msg:${input.clientMessageId}`, roomId: input.roomId };
      },
    }, currentAuthority, 0);
    await delivery.poll(agent); await new Promise((resolve) => setTimeout(resolve, 5));
    await delivery.poll(agent); await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(polls.length, 2);
    assert.equal((await store.receipts("stone")).length, 1);
    assert.deepEqual(published, [{
      clientMessageId: "supervised-room:stone:room:1:reply:v1",
      replyTo: "1",
      threadRootId: "root",
    }]);
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a publish response without a nonempty matching canonical room identity never checkpoints publication", async () => {
  for (const response of [
    { messageId: "", roomId: agent.roomId },
    { messageId: "msg_wrong_room", roomId: "other_room" },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "letagents-delivery-bad-publication-"));
    try {
      const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
      await ingest(store);
      const delivery = new SupervisedAgentDelivery(
        store,
        provider(async () => ({ turnId: "turn_bad_publication", outcome: "reply", text: "reply" })),
        { poll: async () => ({}), publish: async () => response },
        currentAuthority,
        0,
      );
      await delivery.pump(agent);
      const detail = await store.detail(agent.agentId, agent.roomId, "1");
      assert.equal(detail.publication, null);
      assert.equal(detail.receipt?.state, "blocked");
      assert.match(detail.receipt?.last_error ?? "", /canonical message id.*matching room/);
      await store.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("bounded room turns never resolve or inject the legacy charter", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-delivery-charter-refresh-"));
  const store = new SupervisedAgentInboxStore(join(root, "daemon.sqlite"));
  let resolverCalls = 0;
  const seen: Array<{ source: unknown; hasCharter: boolean }> = [];
  const delivery = new SupervisedAgentDelivery(
    store,
    provider(async (_handle, request) => {
      seen.push({ source: request.sourceMessage, hasCharter: Object.hasOwn(request, "charter") });
      return { turnId: `turn:${request.inboxItemId}`, outcome: "no_reply", text: null };
    }),
    { poll: async () => ({}), publish: async () => { throw new Error("no-reply turn must not publish"); } },
    currentAuthority,
    0,
    undefined,
    undefined,
    undefined,
    async () => { resolverCalls += 1; return { charter: "must never be injected" }; },
  );
  try {
    await ingest(store, "1");
    await delivery.pump(agent);
    await ingest(store, "2");
    await delivery.pump(agent);
    assert.equal(resolverCalls, 0);
    assert.deepEqual(seen.map((turn) => turn.hasCharter), [false, false]);
    assert.deepEqual(seen.map((turn) => (turn.source as { id?: string }).id), ["1", "2"]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
