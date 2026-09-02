import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type {
  DesktopGitRoomInfo,
  DesktopManagedAgentSession,
  DesktopRoomMessage,
  DesktopRoomStreamEvent,
  DesktopTaskSummary,
} from "../ipc-types.js";
import { createElectronTestEnv } from "./harness.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const nodeRequire = createRequire(import.meta.url);

const { tempDir } = createElectronTestEnv({
  prefix: "letagents-desktop-local-chat-",
  paths: ["chatStorage", "localChatDb", "localProfile"],
});

const {
  addLocalChatMessage,
  claimUnsyncedLocalChatMessages,
  getLocalChatMessages,
  getLocalChatRoomWriteSequenceValue,
  getLocalChatMessagesBefore,
  getLocalMessageThread,
  getLocalMessageThreads,
  getLocalChatThreadRoutingAgentKeysForRoots,
  getSyncedCloudMessageId,
  importLocalChatMessages,
  markLocalChatMessageSynced,
  markLocalMessageThreadRead,
  setLocalMessageSchemaInitializationObserverForTest,
} = await import("../main/rooms/messages/local-store.js");
const {
  setLocalChatDatabaseInitializationObserverForTest,
} = await import("../main/rooms/local-db.js");
const {
  readLocalProfileId,
  readChatStorageSettings,
  resolveRoomStorageMode,
  setChatStorageMode,
  setRoomStorageMode,
} = await import("../main/chat-storage/settings.js");
const {
  addLocalTask,
  assertLocalRoomPublishable,
  claimLocalTaskReviewLease,
  claimLocalTasksForPublish,
  cloudRoomIdentifierForStorage,
  createLocalRoom,
  getLocalRoomIncludingArchived,
  getLocalTask,
  importLocalTasks,
  localRoomIdentifierForStorage,
  listLocalRoomEntries,
  listLocalTasks,
  markLocalTaskSynced,
  releaseLocalTaskPublishClaim,
  releaseLocalTaskReviewLease,
  resolveLocalAwareRoomStorageMode,
  setLocalAwareRoomStorageMode,
  setLocalRoomArchived,
  setLocalRoomPinned,
  updateLocalTask,
} = await import("../main/rooms/local-store.js");
const {
  buildLocalRoomArtifactIdentityKey,
  getLocalRoomArtifacts,
  publishLocalRoomArtifact,
  syncLocalRoomArtifactsForTask,
} = await import("../main/rooms/artifacts/local-store.js");
const {
  executeManagedAgentContextRequest,
} = await import("../main/agents/managed-agent-context.js");
const {
  desktopMessageAccountRoutingRequest,
  resolveLocalCloudPublishAuthority,
} = await import("../main/rooms/messages.js");
const { registerDesktopRoomIpcHandlers } = await import("../main/ipc-handlers/rooms.js");
const {
  clearLocalManagedMessageDeliveryRetriesForTest,
  deliverDesktopRoomMessageToManagedAgents,
  inspectLocalManagedMessageDeliveryRetriesForTest,
  setLocalAccountAgentRoutingHydratorForTest,
  setManagedAgentRoomStreamDispatcherForTest,
  setLocalRoomMessagePollDependenciesForTest,
  startDesktopRoomStream,
  stopDesktopRoomStream,
} = await import("../main/room-stream.js");
const { mapRoomMessagePayload } = await import("../main/rooms/messages/mappers.js");
const { buildLocalLegacyAccountAgentRouting } = await import(
  "../main/agents/codex-event-routing.js"
);

function localRoutingWorker(input: {
  id: string;
  key: string;
  label: string;
  startedAt: string;
}): DesktopManagedAgentSession {
  return {
    id: input.id,
    providerId: "codex",
    runtime: `codex:${input.id}`,
    roomIdentifier: "github.com/BrosInCode/local-managed-delivery",
    roomDisplayName: "Local managed delivery",
    repoRootPath: tempDir,
    repoBranch: null,
    status: "running",
    deliveryMode: "desktop_events",
    permissionProfileId: "sandboxed_write",
    permissionProfile: {
      id: "sandboxed_write",
      label: "Sandboxed write",
      description: "test",
      status: "available",
      risk: "medium",
      detail: null,
      isDefault: true,
    },
    canStop: true,
    agentSessionId: input.id,
    actorLabel: input.label,
    agentKey: input.key,
    displayName: input.label,
    ownerLabel: "Owner",
    ideLabel: "Codex",
    reasoningSessionId: null,
    activeWork: null,
    pendingPermissionRequests: [],
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
    lastError: null,
  };
}

test("desktop message payload requests always opt into account routing authority", () => {
  assert.deepEqual(desktopMessageAccountRoutingRequest(), {
    headers: { "X-LetAgents-Desktop-Client": "1" },
  });
  assert.deepEqual(desktopMessageAccountRoutingRequest({
    "Content-Type": "application/json",
    "X-LetAgents-Desktop-Client": "0",
  }), {
    headers: {
      "Content-Type": "application/json",
      "X-LetAgents-Desktop-Client": "1",
    },
  });
});

test("local cloud sync preserves exact worker provenance and never promotes it to human control", () => {
  const worker = {
    session_id: "agent_session_exact",
    session_token: "secret",
    agent_key: "owner/worker",
    room_id: "room_cloud",
  };
  assert.equal(resolveLocalCloudPublishAuthority({
    source: "agent",
    publisherAgentKey: worker.agent_key,
    publisherSessionId: worker.session_id,
    localControlAuthorized: true,
    cloudRoomIdentifier: worker.room_id,
    publisherSession: worker,
  }), "worker");
  assert.equal(resolveLocalCloudPublishAuthority({
    source: "agent",
    publisherAgentKey: worker.agent_key,
    publisherSessionId: worker.session_id,
    localControlAuthorized: true,
    cloudRoomIdentifier: worker.room_id,
    publisherSession: null,
  }), null, "a missing exact worker credential cannot fall through to human authority");
  assert.equal(resolveLocalCloudPublishAuthority({
    source: "browser",
    publisherAgentKey: null,
    publisherSessionId: null,
    localControlAuthorized: true,
    cloudRoomIdentifier: worker.room_id,
    publisherSession: null,
  }), "human");
  assert.equal(resolveLocalCloudPublishAuthority({
    source: "browser",
    publisherAgentKey: worker.agent_key,
    publisherSessionId: worker.session_id,
    localControlAuthorized: true,
    cloudRoomIdentifier: worker.room_id,
    publisherSession: worker,
  }), null, "imported worker provenance cannot be relabelled as an owner-human write");
});

test("desktop local database initialization is single-flight for concurrent cold callers", async () => {
  let databaseInitializations = 0;
  let schemaInitializations = 0;
  setLocalChatDatabaseInitializationObserverForTest(() => {
    databaseInitializations += 1;
  });
  setLocalMessageSchemaInitializationObserverForTest(() => {
    schemaInitializations += 1;
    if (schemaInitializations === 1) throw new Error("injected schema failure");
  });

  await assert.rejects(
    addLocalChatMessage("room_cold_init", {
      sender: "Before retry",
      text: "must fail",
      source: "agent",
    }),
    /injected schema failure/,
  );
  const messages = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    addLocalChatMessage("room_cold_init", {
      sender: `Agent ${index}`,
      text: `message ${index}`,
      source: "agent",
    })));

  assert.deepEqual(
    messages.map((message) => message.id).sort((left, right) =>
      Number(left.slice(4)) - Number(right.slice(4))),
    Array.from({ length: 12 }, (_, index) => `msg_${index + 1}`),
  );
  assert.equal(databaseInitializations, 1, "concurrent callers share one database open");
  assert.equal(schemaInitializations, 2, "a failed schema attempt is retried once and shared");
  setLocalChatDatabaseInitializationObserverForTest(null);
  setLocalMessageSchemaInitializationObserverForTest(null);
});

test("local managed delivery retries transient routing authority before consuming dedupe", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/local-routing-retry";
  await createLocalRoom({
    roomIdentifier: "local_routing_retry",
    displayName: "Routing Retry",
    cloudRoomIdentifier,
  });
  await setLocalAwareRoomStorageMode(cloudRoomIdentifier, "local");
  let attempts = 0;
  setLocalAccountAgentRoutingHydratorForTest(async (_roomIdentifier, _localRoomIdentifier, messages) => {
    attempts += 1;
    if (attempts === 1) throw new Error("projection temporarily unavailable");
    return messages.map((message) => ({
      ...message,
      accountAgentRouting: {
        version: 1,
        authority: "legacy" as const,
        recipientAgentKeys: [],
        recipientSessions: [],
        controlAuthorized: true,
      },
    }));
  });
  try {
    await deliverDesktopRoomMessageToManagedAgents(cloudRoomIdentifier, {
      id: "msg_9001",
      sender: "Human",
      text: "continue",
      attachments: [],
      agentPromptKind: null,
      source: "browser",
      timestamp: "2026-08-11T00:00:00.000Z",
      actorLabel: null,
      agentIdentity: null,
      threadRootId: "msg_9000",
      threadReplyToId: "msg_9000",
      thread: null,
      replyTo: null,
    });
    assert.equal(attempts, 1, "the unavailable result returns without marking the message delivered");
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(attempts, 2, "the exact persisted message is rehydrated after projection recovery");
  } finally {
    setLocalAccountAgentRoutingHydratorForTest(null);
  }
});

test("local managed delivery never reinterprets an explicit invalid routing envelope", async () => {
  let hydrationAttempts = 0;
  setLocalAccountAgentRoutingHydratorForTest(async (_roomIdentifier, _localRoomIdentifier, messages) => {
    hydrationAttempts += 1;
    return [...messages];
  });
  try {
    await deliverDesktopRoomMessageToManagedAgents("local_invalid_authority", {
      id: "msg_9002",
      sender: "Imported worker",
      text: "@everyone",
      attachments: [],
      agentPromptKind: null,
      source: "agent",
      timestamp: "2026-08-11T00:00:00.000Z",
      actorLabel: null,
      agentIdentity: null,
      accountAgentRouting: { version: 1, authority: "invalid" },
      threadRootId: "msg_9002",
      threadReplyToId: null,
      thread: null,
      replyTo: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(
      hydrationAttempts,
      0,
      "present-but-invalid imported authority stays silent instead of falling back to legacy routing",
    );
  } finally {
    setLocalAccountAgentRoutingHydratorForTest(null);
  }
});

test("local managed delivery coalesces persistent projection failures into one bounded room retry", async () => {
  let hydrationAttempts = 0;
  setLocalAccountAgentRoutingHydratorForTest(async () => {
    hydrationAttempts += 1;
    throw new Error("projection remains unavailable");
  });
  try {
    await Promise.all(Array.from({ length: 1_000 }, (_, index) =>
      deliverDesktopRoomMessageToManagedAgents("local_retry_storm", {
        id: `msg_${10_000 + index}`,
        sender: "Human",
        text: `continue ${index}`,
        attachments: [],
        agentPromptKind: null,
        source: "browser",
        timestamp: "2026-08-11T00:00:00.000Z",
        actorLabel: null,
        agentIdentity: null,
        threadRootId: `msg_${10_000 + index}`,
        threadReplyToId: null,
        thread: null,
        replyTo: null,
      })));
    assert.deepEqual(inspectLocalManagedMessageDeliveryRetriesForTest(), {
      rooms: 1,
      messages: 500,
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(
      hydrationAttempts,
      1_001,
      "one room retry probes the oldest pending message instead of spawning 1,000 timers",
    );
  } finally {
    clearLocalManagedMessageDeliveryRetriesForTest();
    setLocalAccountAgentRoutingHydratorForTest(null);
  }
});

test("persisted local agent messages reach other managed workers once without poll duplicates", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/local-managed-delivery";
  const localRoomIdentifier = "local_managed_delivery";
  await createLocalRoom({
    roomIdentifier: localRoomIdentifier,
    displayName: "Local managed delivery",
    cloudRoomIdentifier,
  });
  await setLocalAwareRoomStorageMode(cloudRoomIdentifier, "local");

  const oak = localRoutingWorker({
    id: "agent_session_oak",
    key: "owner/oak",
    label: "Oak",
    startedAt: "2026-08-11T00:00:00.000Z",
  });
  const cedar = localRoutingWorker({
    id: "agent_session_cedar",
    key: "owner/cedar",
    label: "Cedar",
    startedAt: "2026-08-11T00:00:01.000Z",
  });
  const workers = [oak, cedar];
  const managedEvents: Array<Extract<DesktopRoomStreamEvent, { type: "message" }>> = [];
  let resolveWaitScheduled!: () => void;
  const waitScheduled = new Promise<void>((resolve) => {
    resolveWaitScheduled = resolve;
  });
  const waitResults: boolean[] = [];

  setManagedAgentRoomStreamDispatcherForTest((event) => {
    if (event.type === "message") managedEvents.push(event);
  });
  setLocalAccountAgentRoutingHydratorForTest(async (_room, _localRoom, messages) =>
    messages.map((message) => ({
      ...message,
      accountAgentRouting: buildLocalLegacyAccountAgentRouting(
        workers,
        message,
        message.threadRootId && message.threadRootId !== message.id
          ? [oak.agentKey!, cedar.agentKey!]
          : [],
      ),
    })));
  setLocalRoomMessagePollDependenciesForTest({
    onWaitScheduled: () => resolveWaitScheduled(),
    onWaitResolved: (notified) => {
      waitResults.push(notified);
    },
  });

  try {
    await startDesktopRoomStream(cloudRoomIdentifier);
    await waitScheduled;
    const root = await addLocalChatMessage(localRoomIdentifier, {
      sender: "Human",
      text: "Coordinate here",
      source: "browser",
    });
    const inputs = [
      { text: "@Oak please inspect", reply_to: null, thread_root_id: null },
      { text: "@everyone status", reply_to: null, thread_root_id: null },
      { text: "Thread update", reply_to: root.id, thread_root_id: root.id },
    ];
    const messages: DesktopRoomMessage[] = [];
    for (const [index, input] of inputs.entries()) {
      const payload = await addLocalChatMessage(localRoomIdentifier, {
        sender: "Cedar",
        text: input.text,
        source: "agent",
        reply_to: input.reply_to,
        thread_root_id: input.thread_root_id,
        publisher_agent_key: cedar.agentKey,
        publisher_agent_session_id: cedar.agentSessionId,
        idempotency_key: `local-managed-delivery:${index}`,
      });
      const message = mapRoomMessagePayload(payload);
      messages.push(message);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    for (const message of messages) {
      const deliveries = managedEvents.filter((event) => event.message.id === message.id);
      assert.equal(
        deliveries.length,
        1,
        `${message.text} is dispatched once through the ordered notification drain`,
      );
      assert.deepEqual(deliveries[0]?.message.accountAgentRouting, {
        version: 1,
        authority: "legacy",
        recipientAgentKeys: ["owner/oak"],
        recipientSessions: [{
          agentKey: "owner/oak",
          agentSessionId: "agent_session_oak",
          activationReason: "local_legacy",
        }],
        controlAuthorized: false,
      }, message.text);
    }
    assert.equal(
      waitResults[0],
      true,
      "the same-process commit wakes the ordered drain instead of waiting for scalar fallback",
    );
  } finally {
    await stopDesktopRoomStream(cloudRoomIdentifier);
    setManagedAgentRoomStreamDispatcherForTest(null);
    setLocalAccountAgentRoutingHydratorForTest(null);
    setLocalRoomMessagePollDependenciesForTest(null);
  }
});

test("local Desktop IPC sends stay behind an older in-flight durable page", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/local-write-order";
  const localRoomIdentifier = "local_write_order";
  await createLocalRoom({
    roomIdentifier: localRoomIdentifier,
    displayName: "Local Write Order",
    cloudRoomIdentifier,
  });
  await setLocalAwareRoomStorageMode(cloudRoomIdentifier, "local");
  const older = mapRoomMessagePayload(
    await addLocalChatMessage(localRoomIdentifier, {
      sender: "Cedar",
      text: "older instruction",
      source: "agent",
      publisher_agent_key: "owner/cedar",
      publisher_agent_session_id: "agent_session_cedar_order",
    }),
  );

  let newer: DesktopRoomMessage | null = null;
  let pageRead = 0;
  let resolveFirstPageStarted!: () => void;
  const firstPageStarted = new Promise<void>((resolve) => {
    resolveFirstPageStarted = resolve;
  });
  let releaseFirstPage!: () => void;
  const firstPageGate = new Promise<void>((resolve) => {
    releaseFirstPage = resolve;
  });
  const deliveredIds: string[] = [];
  setLocalRoomMessagePollDependenciesForTest({
    readMessages: async () => {
      pageRead += 1;
      if (pageRead === 1) {
        resolveFirstPageStarted();
        await firstPageGate;
        return { messages: [older], has_more: true };
      }
      if (pageRead === 2 && newer) {
        return { messages: [newer], has_more: false };
      }
      return { messages: [], has_more: false };
    },
  });
  setLocalAccountAgentRoutingHydratorForTest(async (_room, _localRoom, messages) =>
    messages.map((message) => ({
      ...message,
      accountAgentRouting: {
        version: 1,
        authority: "legacy" as const,
        recipientAgentKeys: [],
        recipientSessions: [],
        controlAuthorized: false,
      },
    })));
  setManagedAgentRoomStreamDispatcherForTest((event) => {
    if (event.type === "message") deliveredIds.push(event.message.id);
  });
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  registerDesktopRoomIpcHandlers({
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, listener);
    },
  } as unknown as Parameters<typeof registerDesktopRoomIpcHandlers>[0]);
  const sendMessage = ipcHandlers.get("desktop:room:send-message");
  assert.ok(sendMessage);

  try {
    await startDesktopRoomStream(cloudRoomIdentifier);
    await firstPageStarted;
    const sendResult = (await sendMessage(
      {},
      cloudRoomIdentifier,
      "newer instruction",
    )) as { message: DesktopRoomMessage };
    newer = sendResult.message;
    assert.deepEqual(
      deliveredIds,
      [],
      "the local IPC send only wakes the ordered lane and cannot bypass the blocked older page",
    );
    releaseFirstPage();
    for (let attempt = 0; attempt < 50 && deliveredIds.length < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(deliveredIds, [older.id, newer.id]);
  } finally {
    releaseFirstPage();
    await stopDesktopRoomStream(cloudRoomIdentifier);
    setLocalRoomMessagePollDependenciesForTest(null);
    setLocalAccountAgentRoutingHydratorForTest(null);
    setManagedAgentRoomStreamDispatcherForTest(null);
  }
});

test("idle local room streams poll one scalar with exponential backoff", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/local-write-sequence";
  const localRoomIdentifier = "local_write_sequence";
  await createLocalRoom({
    roomIdentifier: localRoomIdentifier,
    displayName: "Local write sequence",
    cloudRoomIdentifier,
  });
  await setLocalAwareRoomStorageMode(cloudRoomIdentifier, "local");

  let messagePageReads = 0;
  let writeSequence = 0;
  const waits: number[] = [];
  let releaseBlockedWait!: (notified: boolean) => void;
  const blockedWait = new Promise<boolean>((resolve) => {
    releaseBlockedWait = resolve;
  });
  const neverWait = new Promise<boolean>(() => {});
  setLocalRoomMessagePollDependenciesForTest({
    readMessages: async () => {
      messagePageReads += 1;
      return { messages: [], has_more: false };
    },
    readWriteSequence: async () => writeSequence,
    wait: async (timeoutMs) => {
      waits.push(timeoutMs);
      if (waits.length <= 5) return false;
      return waits.length === 6 ? blockedWait : neverWait;
    },
  });

  try {
    await startDesktopRoomStream(cloudRoomIdentifier);
    while (waits.length < 6) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      messagePageReads,
      1,
      "an idle room drains messages once instead of querying them every interval",
    );
    assert.deepEqual(
      waits.slice(0, 6),
      [250, 500, 1_000, 2_000, 4_000, 5_000],
      "empty scalar checks back off exponentially",
    );

    writeSequence = 1;
    releaseBlockedWait(false);
    while (messagePageReads < 2) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      messagePageReads,
      2,
      "an external sequence change re-enables one message-table drain",
    );
  } finally {
    await stopDesktopRoomStream(cloudRoomIdentifier);
    setLocalRoomMessagePollDependenciesForTest(null);
  }
});

test("local room streams close the write-between-sequence-and-wait race", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/local-write-lost-wake";
  const localRoomIdentifier = "local_write_lost_wake";
  await createLocalRoom({
    roomIdentifier: localRoomIdentifier,
    displayName: "Local write lost wake",
    cloudRoomIdentifier,
  });
  await setLocalAwareRoomStorageMode(cloudRoomIdentifier, "local");

  let sequenceReads = 0;
  let pageReads = 0;
  let writeSequence = 0;
  let interleavedMessage: Awaited<ReturnType<typeof addLocalChatMessage>> | null = null;
  const events: string[] = [];
  let resolveWaitCalled!: () => void;
  const waitCalled = new Promise<void>((resolve) => {
    resolveWaitCalled = resolve;
  });
  setLocalAccountAgentRoutingHydratorForTest(async (_room, _localRoom, messages) =>
    messages.map((message) => ({
      ...message,
      accountAgentRouting: {
        version: 1,
        authority: "legacy" as const,
        recipientAgentKeys: [],
        recipientSessions: [],
        controlAuthorized: false,
      },
    })));
  setLocalRoomMessagePollDependenciesForTest({
    readMessages: async () => {
      pageReads += 1;
      events.push(`drain:${pageReads}`);
      return {
        messages: pageReads === 2 && interleavedMessage ? [interleavedMessage] : [],
        has_more: false,
      };
    },
    readWriteSequence: async () => {
      sequenceReads += 1;
      if (sequenceReads === 3) {
        const observedBeforeWrite = writeSequence;
        interleavedMessage = await addLocalChatMessage(localRoomIdentifier, {
          sender: "Human",
          text: "committed between the scalar read and waiter registration",
          source: "browser",
        });
        writeSequence = 1;
        events.push("write");
        return observedBeforeWrite;
      }
      return writeSequence;
    },
    wait: async () => {
      events.push("wait");
      resolveWaitCalled();
      return await new Promise<boolean>(() => {});
    },
  });

  try {
    await startDesktopRoomStream(cloudRoomIdentifier);
    await waitCalled;
    assert.ok(events.indexOf("drain:2") > events.indexOf("write"));
    assert.ok(
      events.indexOf("drain:2") < events.indexOf("wait"),
      "the generation recheck drains the interleaved write before sleeping",
    );
  } finally {
    await stopDesktopRoomStream(cloudRoomIdentifier);
    setLocalRoomMessagePollDependenciesForTest(null);
    setLocalAccountAgentRoutingHydratorForTest(null);
  }
});

test("large local backlogs yield between bounded message-drain passes", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/local-write-bounded-drain";
  const localRoomIdentifier = "local_write_bounded_drain";
  await createLocalRoom({
    roomIdentifier: localRoomIdentifier,
    displayName: "Local write bounded drain",
    cloudRoomIdentifier,
  });
  await setLocalAwareRoomStorageMode(cloudRoomIdentifier, "local");

  let pageReads = 0;
  let resolveMacrotask!: () => void;
  const macrotaskRan = new Promise<void>((resolve) => {
    resolveMacrotask = resolve;
  });
  setLocalRoomMessagePollDependenciesForTest({
    readMessages: async () => {
      pageReads += 1;
      if (pageReads === 4) setImmediate(resolveMacrotask);
      return { messages: [], has_more: true };
    },
    readWriteSequence: async () => 0,
  });

  try {
    await startDesktopRoomStream(cloudRoomIdentifier);
    await macrotaskRan;
    assert.ok(pageReads >= 4, "one bounded pass reads the expected page budget");
  } finally {
    await stopDesktopRoomStream(cloudRoomIdentifier);
    setLocalRoomMessagePollDependenciesForTest(null);
  }
});

test("local message inserts advance a durable per-room write sequence once", async () => {
  const roomId = "room_write_sequence_trigger";
  assert.equal(await getLocalChatRoomWriteSequenceValue(roomId), 0);
  await addLocalChatMessage(roomId, {
    sender: "Human",
    text: "first",
    source: "browser",
    idempotency_key: "write-sequence-once",
  });
  assert.equal(await getLocalChatRoomWriteSequenceValue(roomId), 1);
  await addLocalChatMessage(roomId, {
    sender: "Human",
    text: "duplicate retry",
    source: "browser",
    idempotency_key: "write-sequence-once",
  });
  assert.equal(
    await getLocalChatRoomWriteSequenceValue(roomId),
    1,
    "idempotent retries do not produce false change notifications",
  );
});

test("desktop local chat store persists messages, replies, and sync metadata", async () => {
  const first = await addLocalChatMessage("room_1", {
    sender: "Human",
    text: "first",
    source: "browser",
  });
  const second = await addLocalChatMessage("room_1", {
    sender: "Agent",
    text: "reply",
    reply_to: first.id,
    source: "agent",
  });

  assert.equal(first.id, "msg_1");
  assert.equal(second.id, "msg_2");
  assert.equal(second.reply_to?.id, "msg_1");

  const afterFirst = await getLocalChatMessages("room_1", { after: first.id });
  assert.deepEqual(afterFirst.messages.map((message) => message.id), ["msg_2"]);

  const beforeSecond = await getLocalChatMessagesBefore("room_1", second.id);
  assert.deepEqual(beforeSecond.messages.map((message) => message.id), ["msg_1"]);

  await markLocalChatMessageSynced({
    roomId: "room_1",
    localMessageId: first.id,
    cloudMessageId: "msg_44",
  });
  const [syncedLocalOrigin] = (await getLocalChatMessages("room_1", {
    after: null,
    limit: 1,
  })).messages;
  assert.equal(syncedLocalOrigin?.local_control_authorized, true);
  assert.equal(
    syncedLocalOrigin?.account_agent_routing,
    undefined,
    "publishing a local-origin message does not reclassify it as an envelope-less cloud import",
  );
  assert.equal(
    await getSyncedCloudMessageId({
      roomId: "room_1",
      localMessageId: first.id,
    }),
    "msg_44",
  );
});

test("desktop local messages enforce canonical ids and shared sender bounds", async () => {
  const root = await addLocalChatMessage("room_contract", {
    sender: "😀".repeat(512),
    text: "boundary",
  });
  assert.equal(root.id, "msg_1");
  await assert.rejects(
    addLocalChatMessage("room_contract", { sender: "x".repeat(513), text: "too many characters" }),
    /must not exceed 512 characters or 2048 UTF-8 bytes/,
  );
  await assert.rejects(
    addLocalChatMessage("room_contract", { sender: "😀".repeat(513), text: "too many bytes" }),
    /must not exceed 512 characters or 2048 UTF-8 bytes/,
  );
  for (const malformed of ["msg_01", "msg_2147483648", "msg_9007199254740993"]) {
    await assert.rejects(
      addLocalChatMessage("room_contract", { sender: "Agent", text: "bad id", reply_to: malformed }),
      /reply_to must be a valid local message id/,
    );
  }
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => { prepare(sql: string): { run(...params: unknown[]): void }; close(): void };
  };
  const database = new DatabaseSync(process.env.LETAGENTS_LOCAL_CHAT_DB!);
  database.prepare(`
    INSERT INTO local_chat_room_sequences (room_id, next_number)
    VALUES ('room_sequence_overflow', 2147483648)
  `).run();
  database.close();
  await assert.rejects(
    addLocalChatMessage("room_sequence_overflow", { sender: "Agent", text: "overflow" }),
    /sequence could not be allocated/,
  );
});

test("desktop local chat store deduplicates idempotent managed failure messages", async () => {
  const input = {
    sender: "letagents",
    text: "Agent could not reply: quota exhausted",
    source: "managed_agent_failure",
    idempotency_key: "managed_agent_failure:session_1:msg_1:quota_exhausted",
  };
  const first = await addLocalChatMessage("room_failure_dedupe", input);
  const repeated = await addLocalChatMessage("room_failure_dedupe", input);
  const page = await getLocalChatMessages("room_failure_dedupe");

  assert.equal(repeated.id, first.id);
  assert.equal(page.messages.length, 1);
});

test("desktop local chat store rejects thread targets hidden from chat", async () => {
  const hidden = await addLocalChatMessage("room_hidden_thread_target", {
    sender: "Agent",
    text: "",
    agent_prompt_kind: "auto",
    source: "agent",
  });
  const visible = await addLocalChatMessage("room_hidden_thread_target", {
    sender: "Human",
    text: "visible root",
    source: "browser",
  });

  await assert.rejects(
    () => addLocalChatMessage("room_hidden_thread_target", {
      sender: "Human",
      text: "reply to hidden prompt",
      reply_to: hidden.id,
      source: "browser",
    }),
    /reply_to must reference a visible local message/,
  );

  await assert.rejects(
    () => addLocalChatMessage("room_hidden_thread_target", {
      sender: "Human",
      text: "quote hidden prompt",
      reply_to: visible.id,
      thread_root_id: hidden.id,
      source: "browser",
    }),
    /thread_root_id must reference a visible local message/,
  );
});

test("desktop local chat store scopes thread reads by reader", async () => {
  const root = await addLocalChatMessage("room_scoped_reads", {
    sender: "Human",
    text: "root",
    source: "browser",
  });
  const firstReply = await addLocalChatMessage("room_scoped_reads", {
    sender: "Agent",
    text: "first reply",
    reply_to: root.id,
    thread_root_id: root.id,
    source: "agent",
  });
  await addLocalChatMessage("room_scoped_reads", {
    sender: "Agent",
    text: "second reply",
    reply_to: firstReply.id,
    thread_root_id: root.id,
    source: "agent",
  });

  const firstReaderInitial = await getLocalMessageThread("room_scoped_reads", root.id, {
    readerKey: "account:first",
  });
  assert.equal(firstReaderInitial?.summary.unread_count, 2);

  await markLocalMessageThreadRead("room_scoped_reads", root.id, firstReply.id, {
    readerKey: "account:first",
  });

  const firstReader = await getLocalMessageThread("room_scoped_reads", root.id, {
    readerKey: "account:first",
  });
  const secondReader = await getLocalMessageThread("room_scoped_reads", root.id, {
    readerKey: "account:second",
  });
  assert.equal(firstReader?.summary.last_read_message_id, firstReply.id);
  assert.equal(firstReader?.summary.unread_count, 1);
  assert.equal(secondReader?.summary.last_read_message_id, null);
  assert.equal(secondReader?.summary.unread_count, 2);
});

test("desktop local chat store lists thread inbox pages with unread filtering", async () => {
  const firstRoot = await addLocalChatMessage("room_thread_inbox", {
    sender: "Human",
    text: "first root",
    source: "browser",
  });
  await addLocalChatMessage("room_thread_inbox", {
    sender: "Agent",
    text: "first reply",
    reply_to: firstRoot.id,
    thread_root_id: firstRoot.id,
    source: "agent",
  });
  const secondRoot = await addLocalChatMessage("room_thread_inbox", {
    sender: "Human",
    text: "second root",
    source: "browser",
  });
  const secondReply = await addLocalChatMessage("room_thread_inbox", {
    sender: "Agent",
    text: "second reply",
    reply_to: secondRoot.id,
    thread_root_id: secondRoot.id,
    source: "agent",
  });

  const allThreads = await getLocalMessageThreads("room_thread_inbox", {
    readerKey: "account:inbox",
  });
  assert.deepEqual(allThreads.threads.map((item) => item.root.id), [secondRoot.id, firstRoot.id]);
  assert.equal(allThreads.unread_thread_count, 2);

  await markLocalMessageThreadRead("room_thread_inbox", secondRoot.id, secondReply.id, {
    readerKey: "account:inbox",
  });
  const unreadThreads = await getLocalMessageThreads("room_thread_inbox", {
    filter: "unread",
    readerKey: "account:inbox",
  });
  assert.deepEqual(unreadThreads.threads.map((item) => item.root.id), [firstRoot.id]);
  assert.equal(unreadThreads.unread_thread_count, 1);
});

test("desktop local chat import seeds thread read state from cloud metadata", async () => {
  await importLocalChatMessages("room_import_read_state", [
    {
      id: "msg_10",
      sender: "Human",
      text: "root",
      attachments: [],
      source: "browser",
      timestamp: "2026-01-01T00:00:00.000Z",
      thread_root_id: "msg_10",
      thread_reply_to_id: null,
      reply_to: null,
      thread: {
        root_message_id: "msg_10",
        reply_count: 1,
        unread_count: 0,
        has_unread: false,
        latest_reply: {
          id: "msg_11",
          sender: "Agent",
          text: "reply",
          source: "agent",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        participants: [],
        last_read_message_id: "msg_11",
      },
    },
    {
      id: "msg_11",
      sender: "Agent",
      text: "reply",
      attachments: [],
      source: "agent",
      timestamp: "2026-01-01T00:00:01.000Z",
      thread_root_id: "msg_10",
      thread_reply_to_id: "msg_10",
      reply_to: {
        id: "msg_10",
        sender: "Human",
        text: "root",
        source: "browser",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      thread: null,
    },
  ], {
    readerKey: "account:seeded",
  });

  const page = await getLocalMessageThread("room_import_read_state", "msg_1", {
    readerKey: "account:seeded",
  });
  assert.equal(page?.summary.last_read_message_id, "msg_2");
  assert.equal(page?.summary.unread_count, 0);

  const otherReaderPage = await getLocalMessageThread("room_import_read_state", "msg_1", {
    readerKey: "account:other",
  });
  assert.equal(otherReaderPage?.summary.last_read_message_id, null);
  assert.equal(otherReaderPage?.summary.unread_count, 1);
});

test("desktop cloud import resolves reply edges independently of timestamp order", async () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  await importLocalChatMessages("room_import_reply_first", [
    {
      id: "msg_101",
      sender: "Agent",
      text: "first reply",
      attachments: [],
      source: "agent",
      timestamp,
      thread_root_id: "msg_100",
      thread_reply_to_id: "msg_100",
      reply_to: { id: "msg_100", sender: "Human", text: "root", source: "browser", timestamp },
      thread: null,
    },
    {
      id: "msg_102",
      sender: "Agent",
      text: "nested reply",
      attachments: [],
      source: "agent",
      timestamp,
      thread_root_id: "msg_100",
      thread_reply_to_id: "msg_101",
      reply_to: { id: "msg_101", sender: "Agent", text: "first reply", source: "agent", timestamp },
      thread: null,
    },
    {
      id: "msg_100",
      sender: "Human",
      text: "root",
      attachments: [],
      source: "browser",
      timestamp,
      thread_root_id: "msg_100",
      thread_reply_to_id: null,
      reply_to: null,
      thread: null,
    },
  ]);

  const messages = await getLocalChatMessages("room_import_reply_first");
  const root = messages.messages.find((message) => message.text === "root")!;
  const firstReply = messages.messages.find((message) => message.text === "first reply")!;
  const nestedReply = messages.messages.find((message) => message.text === "nested reply")!;
  assert.equal(firstReply.reply_to?.id, root.id);
  assert.equal(firstReply.thread_root_id, root.id);
  assert.equal(nestedReply.reply_to?.id, firstReply.id);
  assert.equal(nestedReply.thread_root_id, root.id);
  const thread = await getLocalMessageThread("room_import_reply_first", root.id);
  assert.deepEqual(thread?.replies.map((message) => message.text), ["first reply", "nested reply"]);
});

test("desktop cloud edge correction removes the reply's obsolete phantom root", async () => {
  const room = "room_import_reply_before_root";
  const timestamp = "2026-01-01T00:00:00.000Z";
  const reply = {
    id: "msg_201",
    sender: "Oak",
    text: "reply before root",
    attachments: [],
    source: "agent",
    timestamp,
    thread_root_id: "msg_200",
    thread_reply_to_id: "msg_200",
    reply_to: { id: "msg_200", sender: "Human", text: "root", source: "browser", timestamp },
    thread: null,
    agent_identity: {
      actor_label: "Oak",
      agent_key: "owner/oak",
      agent_session_id: "oak-session",
    },
  };
  await importLocalChatMessages(room, [reply]);
  await importLocalChatMessages(room, [{
    id: "msg_200",
    sender: "Human",
    text: "root",
    attachments: [],
    source: "browser",
    timestamp,
    thread_root_id: "msg_200",
    thread_reply_to_id: null,
    reply_to: null,
    thread: null,
  }, reply]);

  let membership: Awaited<ReturnType<typeof getLocalChatThreadRoutingAgentKeysForRoots>> | null = null;
  for (let attempt = 0; attempt < 50 && !membership; attempt += 1) {
    try {
      membership = await getLocalChatThreadRoutingAgentKeysForRoots(
        room,
        ["msg_1", "msg_2"],
        [{ agentKey: "owner/oak", actorLabel: "Oak", displayName: "Oak" }],
      );
    } catch (error) {
      if ((error as { name?: string }).name !== "LocalThreadRoutingProjectionUnavailableError") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(membership);
  assert.deepEqual([...(membership.get("msg_1") ?? [])], []);
  assert.deepEqual([...(membership.get("msg_2") ?? [])], ["owner/oak"]);
});

test("desktop cloud-to-local import preserves durable publisher routing authority", async () => {
  // Model a staggered rollout: the first import came from a client that did
  // not persist the new trusted publisher/control fields.
  await importLocalChatMessages("room_import_durable_publisher", [
    {
      id: "msg_20",
      sender: "Old visible label",
      text: "root",
      attachments: [],
      source: "agent",
      timestamp: "2026-01-02T00:00:00.000Z",
      thread_root_id: "msg_20",
      thread_reply_to_id: null,
      reply_to: null,
      thread: null,
    },
    {
      id: "msg_21",
      sender: "Human",
      text: "/stop-codex-room",
      attachments: [],
      source: "browser",
      timestamp: "2026-01-02T00:00:01.000Z",
      thread_root_id: "msg_20",
      thread_reply_to_id: "msg_20",
      reply_to: null,
      thread: null,
    },
  ]);
  await importLocalChatMessages("room_import_durable_publisher", [
    {
      id: "msg_20",
      sender: "Old visible label",
      text: "root",
      attachments: [],
      source: "agent",
      timestamp: "2026-01-02T00:00:00.000Z",
      thread_root_id: "msg_20",
      thread_reply_to_id: null,
      reply_to: null,
      thread: null,
      agent_identity: {
        actor_label: "Old visible label",
        agent_key: "local/stable-key",
        agent_session_id: "cloud-old-session",
      },
    },
    {
      id: "msg_21",
      sender: "Human",
      text: "/stop-codex-room",
      attachments: [],
      source: "browser",
      timestamp: "2026-01-02T00:00:01.000Z",
      thread_root_id: "msg_20",
      thread_reply_to_id: "msg_20",
      reply_to: {
        id: "msg_20",
        sender: "Old visible label",
        text: "root",
        source: "agent",
        timestamp: "2026-01-02T00:00:00.000Z",
      },
      thread: null,
      account_agent_routing: {
        version: 1,
        authority: "legacy",
        recipient_agent_keys: [],
        recipient_agent_sessions: [],
        control_authorized: false,
      },
    },
    {
      id: "msg_22",
      sender: "Owner",
      text: "/stop-cursor-room",
      attachments: [],
      source: "browser",
      timestamp: "2026-01-02T00:00:02.000Z",
      thread_root_id: "msg_22",
      thread_reply_to_id: null,
      reply_to: null,
      thread: null,
      account_agent_routing: {
        version: 1,
        authority: "receipts",
        recipient_agent_keys: [],
        recipient_agent_sessions: [],
        control_authorized: true,
      },
    },
    {
      id: "msg_23",
      sender: "Human",
      text: "old server row without routing",
      attachments: [],
      source: "browser",
      timestamp: "2026-01-02T00:00:03.000Z",
      thread_root_id: "msg_23",
      thread_reply_to_id: null,
      reply_to: null,
      thread: null,
    },
  ], { readerKey: "account:owner" });

  const imported = await getLocalChatMessages("room_import_durable_publisher", {
    readerKey: "account:owner",
  });
  assert.equal(imported.messages.find((message) => message.id === "msg_1")?.agent_identity?.agent_session_id,
    "cloud-old-session");
  assert.equal(imported.messages.find((message) => message.id === "msg_2")?.local_control_authorized, false,
    "a collaborator-authored browser stop remains unauthorized after a cloud-to-local fork");
  assert.deepEqual(imported.messages.find((message) => message.id === "msg_2")?.account_agent_routing, {
    version: 1,
    authority: "legacy",
    recipient_agent_keys: [],
    recipient_agent_sessions: [],
    control_authorized: false,
  }, "immutable cloud routing authority survives local replay");
  assert.equal(imported.messages.find((message) => message.id === "msg_3")?.local_control_authorized, true,
    "the importing owner retains their account-scoped stop authority");
  assert.deepEqual(imported.messages.find((message) => message.id === "msg_4")?.account_agent_routing, {
    version: 1,
    authority: "invalid",
  }, "a cloud-imported row without an envelope never becomes mutable local legacy authority");

  const otherAccount = await getLocalChatMessages("room_import_durable_publisher", {
    readerKey: "account:other",
  });
  const otherAccountStop = otherAccount.messages.find((message) => message.id === "msg_2");
  assert.deepEqual(otherAccountStop?.account_agent_routing, {
    version: 1,
    authority: "invalid",
  }, "an account-scoped cloud routing envelope fails closed after an account switch");
  assert.equal(otherAccountStop?.local_control_authorized, false,
    "owner control authority never crosses the imported routing audience");
  const otherAccountOwnerStop = otherAccount.messages.find((message) => message.id === "msg_3");
  assert.deepEqual(otherAccountOwnerStop?.account_agent_routing, {
    version: 1,
    authority: "invalid",
  });
  assert.equal(otherAccountOwnerStop?.local_control_authorized, false);

  const membership = await getLocalChatThreadRoutingAgentKeysForRoots(
    "room_import_durable_publisher",
    ["msg_1"],
    [
      {
        agentKey: "local/stable-key",
        actorLabel: "Renamed legitimate worker",
        displayName: "Maple",
      },
      {
        agentKey: "local/impostor",
        actorLabel: "Old visible label",
        displayName: "Old visible label",
      },
    ],
  );
  assert.deepEqual(
    [...(membership.get("msg_1") ?? [])],
    ["local/stable-key"],
    "the imported authenticated key outranks a later worker reusing the old display alias",
  );
});

test("desktop cloud publisher correction replaces stale local routing projection", async () => {
  const base = {
    id: "msg_30",
    sender: "Historical label",
    text: "root",
    attachments: [],
    source: "agent",
    timestamp: "2026-01-03T00:00:00.000Z",
    thread_root_id: "msg_30",
    thread_reply_to_id: null,
    reply_to: null,
    thread: null,
  };
  await importLocalChatMessages("room_import_publisher_correction", [{
    ...base,
    agent_identity: {
      actor_label: "Historical label",
      agent_key: "owner/key-a",
      agent_session_id: "session_a",
    },
  }]);
  await importLocalChatMessages("room_import_publisher_correction", [{
    ...base,
    agent_identity: {
      actor_label: "Historical label",
      agent_key: "owner/key-b",
      agent_session_id: "session_b",
    },
  }]);

  const membership = await getLocalChatThreadRoutingAgentKeysForRoots(
    "room_import_publisher_correction",
    ["msg_1"],
    [
      { agentKey: "owner/key-a", actorLabel: "A", displayName: "A" },
      { agentKey: "owner/key-b", actorLabel: "B", displayName: "B" },
    ],
  );
  assert.deepEqual([...(membership.get("msg_1") ?? [])], ["owner/key-b"]);
});

test("desktop cloud publisher correction invalidates a large root without foreground replay", async () => {
  const room = "room_import_large_publisher_correction";
  const base = {
    id: "msg_40",
    sender: "Historical label",
    text: "root",
    attachments: [],
    source: "agent",
    timestamp: "2026-01-04T00:00:00.000Z",
    thread_root_id: "msg_40",
    thread_reply_to_id: null,
    reply_to: null,
    thread: null,
  };
  await importLocalChatMessages(room, [{
    ...base,
    agent_identity: {
      actor_label: "Historical label",
      agent_key: "owner/old-key",
      agent_session_id: "old-session",
    },
  }]);
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        get(...params: unknown[]): Record<string, unknown> | undefined;
        run(...params: unknown[]): void;
      };
      close(): void;
    };
  };
  const raw = new DatabaseSync(process.env.LETAGENTS_LOCAL_CHAT_DB!);
  raw.exec("BEGIN IMMEDIATE");
  try {
    raw.prepare(`
      WITH RECURSIVE replies(number) AS (
        SELECT 2 UNION ALL SELECT number + 1 FROM replies WHERE number <= 5001
      )
      INSERT INTO local_chat_messages (
        room_id, number, thread_root_number, sender, text, source, timestamp
      )
      SELECT ?, number, 1, 'Reply ' || number, 'body', 'agent',
             '2026-01-04T00:00:01.000Z'
        FROM replies
    `).run(room);
    raw.prepare(`
      WITH RECURSIVE projected(number) AS (
        SELECT 1 UNION ALL SELECT number + 1 FROM projected WHERE number < 2000
      )
      INSERT INTO local_chat_thread_routing_aliases_v2 (
        room_id, thread_root_number, participant_hash, participant_text,
        alias_hash, alias_text, is_full
      )
      SELECT ?, 1, printf('%032x', number), 'Participant ' || number,
             printf('%032x', number + 10000), 'alias ' || number, 1
        FROM projected
    `).run(room);
    raw.prepare(`
      WITH RECURSIVE projected(number) AS (
        SELECT 1 UNION ALL SELECT number + 1 FROM projected WHERE number < 2000
      )
      INSERT INTO local_chat_thread_routing_agents_v2 (
        room_id, thread_root_number, participant_hash, participant_text,
        agent_key_hash, agent_key
      )
      SELECT ?, 1, printf('%032x', number), 'Participant ' || number,
             printf('%032x', number + 20000), 'owner/key-' || number
        FROM projected
    `).run(room);
    raw.exec("COMMIT");
  } catch (error) {
    raw.exec("ROLLBACK");
    throw error;
  } finally {
    raw.close();
  }

  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  const startedAt = performance.now();
  await importLocalChatMessages(room, [{
    ...base,
    agent_identity: {
      actor_label: "Historical label",
      agent_key: "owner/new-key",
      agent_session_id: "new-session",
    },
  }]);
  const correctionMs = performance.now() - startedAt;
  const afterCorrection = new DatabaseSync(process.env.LETAGENTS_LOCAL_CHAT_DB!);
  const retainedProjection = afterCorrection.prepare(`
    SELECT
      (SELECT COUNT(*) FROM local_chat_thread_routing_aliases_v2
        WHERE room_id = ? AND thread_root_number = 1) AS alias_count,
      (SELECT COUNT(*) FROM local_chat_thread_routing_agents_v2
        WHERE room_id = ? AND thread_root_number = 1) AS agent_count,
      (SELECT COUNT(*) FROM local_chat_thread_routing_invalidated_roots_v2
        WHERE room_id = ? AND thread_root_number = 1) AS invalidated_count
  `).get(room, room, room);
  afterCorrection.close();
  assert.equal(Number(retainedProjection?.alias_count), 2000);
  assert.equal(Number(retainedProjection?.agent_count), 2000);
  assert.equal(Number(retainedProjection?.invalidated_count), 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(timerFired, true, "the correction leaves the event loop available for async repair");
  assert.ok(correctionMs < 100, `publisher correction touched historical projection rows (${correctionMs.toFixed(1)}ms)`);

  let membership: Awaited<ReturnType<typeof getLocalChatThreadRoutingAgentKeysForRoots>> | null = null;
  for (let attempt = 0; attempt < 100 && !membership; attempt += 1) {
    try {
      membership = await getLocalChatThreadRoutingAgentKeysForRoots(
        room,
        ["msg_1"],
        [
          { agentKey: "owner/old-key", actorLabel: "Old", displayName: "Old" },
          { agentKey: "owner/new-key", actorLabel: "New", displayName: "New" },
        ],
      );
    } catch (error) {
      if ((error as { name?: string }).name !== "LocalThreadRoutingProjectionUnavailableError") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(membership, "the queued root repair eventually completes");
  assert.deepEqual([...(membership.get("msg_1") ?? [])], ["owner/new-key"]);
});

test("desktop local chat store claims unsynced messages with stable sync keys", async () => {
  const message = await addLocalChatMessage("room_sync", {
    sender: "Human",
    text: "sync me",
    source: "browser",
  });

  const firstClaim = await claimUnsyncedLocalChatMessages("room_sync");
  assert.deepEqual(firstClaim.map((entry) => entry.id), [message.id]);
  assert.equal(firstClaim[0]?.sync_key, "local-chat:room_sync:1");

  const overlappingClaim = await claimUnsyncedLocalChatMessages("room_sync");
  assert.deepEqual(overlappingClaim, []);

  await markLocalChatMessageSynced({
    roomId: "room_sync",
    localMessageId: message.id,
    cloudMessageId: "msg_9",
  });
  assert.deepEqual(await claimUnsyncedLocalChatMessages("room_sync"), []);
});

test("desktop local chat keeps attachment-only messages visible in history, sync, and thread summaries", async () => {
  const attachmentOnly = await addLocalChatMessage("room_visibility_null", {
    sender: "Human",
    text: "",
    source: "browser",
    attachments: [{
      id: "att_only",
      file_name: "notes.txt",
      mime_type: "text/plain",
      size_bytes: 5,
      content_base64: "aGVsbG8=",
    }],
  });
  const hiddenPrompt = await addLocalChatMessage("room_visibility_null", {
    sender: "Agent",
    text: "",
    agent_prompt_kind: "auto",
    source: "agent",
  });
  const attachmentReply = await addLocalChatMessage("room_visibility_null", {
    sender: "Agent",
    text: "",
    reply_to: attachmentOnly.id,
    thread_root_id: attachmentOnly.id,
    source: "agent",
  });

  const history = await getLocalChatMessages("room_visibility_null");
  assert.deepEqual(history.messages.map((message) => message.id), [
    attachmentOnly.id,
    attachmentReply.id,
  ]);
  assert.equal(history.messages[0]?.attachments?.[0]?.id, "att_only");
  assert.equal(history.messages.some((message) => message.id === hiddenPrompt.id), false);

  const syncClaim = await claimUnsyncedLocalChatMessages("room_visibility_null");
  assert.deepEqual(syncClaim.map((message) => message.id), [
    attachmentOnly.id,
    attachmentReply.id,
  ]);

  const thread = await getLocalMessageThread("room_visibility_null", attachmentOnly.id);
  assert.deepEqual(thread?.replies.map((message) => message.id), [attachmentReply.id]);
  assert.equal(thread?.summary.reply_count, 1);
  assert.equal(thread?.summary.latest_reply?.id, attachmentReply.id);

  const inbox = await getLocalMessageThreads("room_visibility_null");
  assert.deepEqual(inbox.threads.map((item) => item.root.id), [attachmentOnly.id]);
  assert.equal(inbox.threads[0]?.summary.latest_reply?.id, attachmentReply.id);
});

test("desktop storage resolver applies app default, room overrides, and local metadata", async () => {
  await setChatStorageMode("cloud");
  assert.equal((await resolveRoomStorageMode("room_a")).effectiveMode, "cloud");

  await setRoomStorageMode("room_a", "local");
  assert.equal((await resolveRoomStorageMode("room_a")).effectiveMode, "local");

  await setRoomStorageMode("room_a", "inherit");
  assert.equal((await resolveRoomStorageMode("room_a")).effectiveMode, "cloud");

  await setChatStorageMode("local");
  assert.equal((await resolveRoomStorageMode("room_b")).effectiveMode, "local");

  await setRoomStorageMode("room_b", "cloud");
  assert.equal((await resolveRoomStorageMode("room_b")).effectiveMode, "cloud");

  await setChatStorageMode("cloud");
  const localOnly = await createLocalRoom({
    roomIdentifier: "local_only",
    displayName: "Local Only",
  });
  assert.equal(localOnly.publishStatus, "local_only");
  assert.equal((await resolveLocalAwareRoomStorageMode("local_only")).effectiveMode, "local");
  assert.equal(
    (await resolveLocalAwareRoomStorageMode("git-room:local:1234567890abcdef:branch:Zm9v")).effectiveMode,
    "local",
  );

  const forked = await createLocalRoom({
    roomIdentifier: "forked_room",
    displayName: "Forked",
    cloudRoomIdentifier: "github.com/BrosInCode/letagents",
  });
  assert.equal(forked.publishStatus, "linked");
  assert.equal((await resolveLocalAwareRoomStorageMode("forked_room")).effectiveMode, "local");

  await setRoomStorageMode("forked_room", "cloud");
  const cloudOverride = await resolveLocalAwareRoomStorageMode("forked_room");
  assert.equal(cloudOverride.effectiveMode, "cloud");
  assert.equal(cloudOverride.localRoom?.cloudRoomIdentifier, "github.com/BrosInCode/letagents");
  assert.equal(
    cloudRoomIdentifierForStorage(cloudOverride, "forked_room"),
    "github.com/BrosInCode/letagents",
  );
  assert.equal(localRoomIdentifierForStorage(cloudOverride, "forked_room"), "forked_room");

  const settings = await readChatStorageSettings();
  assert.equal(settings.roomOverrides.forked_room, "cloud");
});

test("desktop linked local rooms keep separate local and cloud identifiers", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/linked-local-room";
  const linked = await createLocalRoom({
    displayName: "Linked Local Room",
    cloudRoomIdentifier,
  });
  assert.notEqual(linked.roomIdentifier, cloudRoomIdentifier);

  await setRoomStorageMode(linked.roomIdentifier, "local");
  const storage = await resolveLocalAwareRoomStorageMode(cloudRoomIdentifier);
  assert.equal(storage.effectiveMode, "local");
  assert.equal(storage.localRoom?.roomIdentifier, linked.roomIdentifier);
  assert.equal(storage.localRoom?.cloudRoomIdentifier, cloudRoomIdentifier);
  assert.equal(localRoomIdentifierForStorage(storage, cloudRoomIdentifier), linked.roomIdentifier);

  await setRoomStorageMode(linked.roomIdentifier, "cloud");
  const cloudStorage = await resolveLocalAwareRoomStorageMode(cloudRoomIdentifier);
  assert.equal(cloudStorage.effectiveMode, "cloud");
  assert.equal(cloudRoomIdentifierForStorage(cloudStorage, linked.roomIdentifier), cloudRoomIdentifier);
});

test("desktop local Git rooms persist Git metadata for snapshots and account entries", async () => {
  const gitRoom: DesktopGitRoomInfo = {
    provider: "git",
    host: "local",
    repository: {
      id: "local:repo",
      fullName: "FBRF",
      owner: "local",
      name: "FBRF",
    },
    ref: {
      type: "branch",
      name: "feature/player-3d-presentation",
      defaultBranch: "main",
      baseRef: "main",
      headRef: "feature/player-3d-presentation",
      headRepository: null,
    },
    visibility: "local",
    accessMode: "local",
    isDefault: false,
    source: "local_git",
  };

  const room = await createLocalRoom({
    roomIdentifier: "git-room:local:fbrf:branch:feature",
    displayName: "FBRF",
    gitRoom,
  });

  assert.equal(room.gitRoom?.accessMode, "local");
  assert.equal(room.gitRoom?.ref.name, "feature/player-3d-presentation");

  const persisted = await getLocalRoomIncludingArchived(room.roomIdentifier);
  assert.equal(persisted?.gitRoom?.repository.fullName, "FBRF");

  const accountEntry = (await listLocalRoomEntries())
    .find((entry) => entry.roomIdentifier === room.roomIdentifier);
  assert.equal(accountEntry?.gitRoom?.source, "local_git");
  assert.equal(accountEntry?.gitRoom?.accessMode, "local");
  assert.throws(
    () => assertLocalRoomPublishable(room),
    /Local Git Rooms stay local/,
  );
});

test("desktop local room artifacts persist and link to tasks", async () => {
  const room = await createLocalRoom({
    roomIdentifier: "local_artifacts_room",
    displayName: "Local Artifacts",
  });
  assert.equal(
    buildLocalRoomArtifactIdentityKey({
      provider: "git",
      kind: "commit",
      id: "abc123",
    }),
    "git:commit:id:abc123",
  );

  const published = await publishLocalRoomArtifact({
    roomId: room.roomIdentifier,
    artifact: {
      provider: "git",
      kind: "commit",
      id: "abc123",
      title: "Initial local commit",
      ref: "feature/local-artifacts",
      state: "created",
    },
    linkedTaskIds: ["task_1"],
  });
  assert.equal(published.artifact.provider, "git");
  assert.equal(published.artifact.kind, "commit");
  assert.deepEqual(published.artifact.linked_task_ids, ["task_1"]);

  await publishLocalRoomArtifact({
    roomId: room.roomIdentifier,
    artifact: {
      provider: "git",
      kind: "commit",
      id: "abc123",
      title: "Updated local commit",
    },
    taskId: "task_2",
  });

  const artifacts = await getLocalRoomArtifacts(room.roomIdentifier);
  assert.equal(artifacts.artifacts?.length, 1);
  assert.equal(artifacts.artifacts?.[0]?.title, "Updated local commit");
  assert.equal(artifacts.artifacts?.[0]?.ref, "feature/local-artifacts");
  assert.equal(artifacts.artifacts?.[0]?.state, "created");
  assert.deepEqual(artifacts.artifacts?.[0]?.linked_task_ids, ["task_1", "task_2"]);

  const filtered = await getLocalRoomArtifacts(room.roomIdentifier, { taskId: "task_2" });
  assert.equal(filtered.artifacts?.[0]?.identity_key, "git:commit:id:abc123");
  await syncLocalRoomArtifactsForTask({
    roomId: room.roomIdentifier,
    taskId: "task_3",
    artifacts: [{
      provider: "git",
      kind: "commit",
      id: "abc123",
      title: "Task sync title",
    }],
  });
  const afterTaskSync = await getLocalRoomArtifacts(room.roomIdentifier);
  assert.equal(afterTaskSync.artifacts?.[0]?.title, "Updated local commit");
  assert.equal(afterTaskSync.artifacts?.[0]?.source, "manual");

  await assert.rejects(
    publishLocalRoomArtifact({
      roomId: room.roomIdentifier,
      artifact: { provider: "git", kind: "commit", title: "Missing identity" },
    }),
    /stable identity/,
  );
  await assert.rejects(
    publishLocalRoomArtifact({
      roomId: room.roomIdentifier,
      artifact: { provider: "git", kind: "commit", number: null },
    }),
    /stable identity/,
  );
});

test("managed agent local context resolves linked local room artifacts", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/context-linked-local-room";
  const linked = await createLocalRoom({
    roomIdentifier: "context_linked_local_room",
    displayName: "Context Linked Local Room",
    cloudRoomIdentifier,
  });
  await setLocalAwareRoomStorageMode(cloudRoomIdentifier, "local");
  await publishLocalRoomArtifact({
    roomId: linked.roomIdentifier,
    artifact: {
      provider: "git",
      kind: "commit",
      id: "ctx123",
      title: "Context commit",
    },
  });

  const result = await executeManagedAgentContextRequest({
    session_id: "context_session",
    room_id: cloudRoomIdentifier,
    room_identifier: cloudRoomIdentifier,
    joined_via: "join_room",
    cwd: tempDir,
    stop_phrase: "stop",
    max_minutes: 30,
    token: "token",
    thread_id: "thread",
    turn_id: "turn",
    server_url: "http://127.0.0.1",
    launched_server: false,
    codex_bin: "codex",
    status: "completed",
    started_at: "2026-07-04T00:00:00.000Z",
    updated_at: "2026-07-04T00:00:00.000Z",
  } as any, {
    tool: "get_room_context_summary",
    arguments: {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.storage, "local");
  assert.equal(result.roomIdentifier, linked.roomIdentifier);
  assert.equal((result.artifacts as any[])?.[0]?.identityKey, "git:commit:id:ctx123");
});

test("desktop linked local rooms use the cloud room as the visible account identity", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/visible-linked-local-room";
  const linked = await createLocalRoom({
    displayName: "Visible Linked Local Room",
    cloudRoomIdentifier,
  });

  await setRoomStorageMode(linked.roomIdentifier, "cloud");
  await setRoomStorageMode(cloudRoomIdentifier, "local");
  const storage = await resolveLocalAwareRoomStorageMode(cloudRoomIdentifier);
  assert.equal(storage.effectiveMode, "local");
  assert.equal(storage.localRoom?.roomIdentifier, linked.roomIdentifier);
  assert.equal(storage.overrideMode, "local");

  const localEntries = await listLocalRoomEntries({ linkedIdentity: "local" });
  assert.equal(
    localEntries.find((entry) => entry.roomIdentifier === linked.roomIdentifier)?.displayName,
    "Visible Linked Local Room",
  );

  const visibleEntries = await listLocalRoomEntries({ linkedIdentity: "cloud" });
  assert.equal(
    visibleEntries.find((entry) => entry.roomIdentifier === cloudRoomIdentifier)?.displayName,
    "Visible Linked Local Room",
  );
  assert.equal(
    visibleEntries.some((entry) => entry.roomIdentifier === linked.roomIdentifier),
    false,
  );
});

test("desktop room storage changes clear stale linked-room alias overrides", async () => {
  const cloudRoomIdentifier = "github.com/BrosInCode/toggle-linked-local-room";
  const linked = await createLocalRoom({
    displayName: "Toggle Linked Local Room",
    cloudRoomIdentifier,
  });

  await setRoomStorageMode(linked.roomIdentifier, "cloud");
  const localStorage = await setLocalAwareRoomStorageMode(cloudRoomIdentifier, "local");
  assert.equal(localStorage.effectiveMode, "local");
  assert.equal(localStorage.localRoom?.roomIdentifier, linked.roomIdentifier);

  let settings = await readChatStorageSettings();
  assert.equal(settings.roomOverrides[cloudRoomIdentifier], "local");
  assert.equal(settings.roomOverrides[linked.roomIdentifier], undefined);

  const cloudStorage = await setLocalAwareRoomStorageMode(cloudRoomIdentifier, "cloud");
  assert.equal(cloudStorage.effectiveMode, "cloud");
  assert.equal(cloudStorage.localRoom?.roomIdentifier, linked.roomIdentifier);

  settings = await readChatStorageSettings();
  assert.equal(settings.roomOverrides[cloudRoomIdentifier], "cloud");
  assert.equal(settings.roomOverrides[linked.roomIdentifier], undefined);
});

test("desktop local room pinning persists in local account room entries", async () => {
  const room = await createLocalRoom({
    roomIdentifier: "pin_room",
    displayName: "Pin Room",
  });
  assert.equal((await listLocalRoomEntries()).find((entry) => entry.roomIdentifier === room.roomIdentifier)?.pinned, false);

  await setLocalRoomPinned(room.roomIdentifier, true);
  assert.equal((await listLocalRoomEntries()).find((entry) => entry.roomIdentifier === room.roomIdentifier)?.pinned, true);

  await setLocalRoomPinned(room.roomIdentifier, false);
  assert.equal((await listLocalRoomEntries()).find((entry) => entry.roomIdentifier === room.roomIdentifier)?.pinned, false);
});

test("desktop archived local rooms can be restored from archived-aware lookup", async () => {
  const room = await createLocalRoom({
    roomIdentifier: "restore_local_room",
    displayName: "Restore Local Room",
  });

  await setLocalRoomArchived(room.roomIdentifier, true);
  assert.equal(
    (await listLocalRoomEntries()).some((entry) => entry.roomIdentifier === room.roomIdentifier),
    false,
  );
  assert.equal(
    (await getLocalRoomIncludingArchived(room.roomIdentifier))?.displayName,
    "Restore Local Room",
  );

  await setLocalRoomArchived(room.roomIdentifier, false);
  assert.equal(
    (await listLocalRoomEntries()).some((entry) => entry.roomIdentifier === room.roomIdentifier),
    true,
  );
});

test("desktop local profile id is stable across concurrent first reads", async () => {
  const ids = await Promise.all(Array.from({ length: 8 }, () => readLocalProfileId()));
  assert.equal(new Set(ids).size, 1);
});

test("desktop local room task store supports board create and lifecycle updates", async () => {
  await createLocalRoom({
    roomIdentifier: "task_room",
    displayName: "Task Room",
  });

  const task = await addLocalTask("task_room", {
    title: "Draft local task",
    description: "Only on this machine",
    createdBy: "Emmy",
  });
  assert.equal(task.id, "task_1");
  assert.equal(task.status, "proposed");
  assert.equal(task.createdBy, "Emmy");

  const updated = await updateLocalTask("task_room", task.id, {
    status: "accepted",
    assignee: "Local Agent",
    assigneeAgentKey: "local/agent",
    prUrl: "https://github.com/BrosInCode/letagents/pull/1",
    workflowArtifacts: [{
      provider: "git",
      kind: "commit",
      id: "def456",
      number: null,
      title: "Local task commit",
      url: null,
      ref: null,
      state: null,
    }],
  });
  assert.equal(updated.status, "accepted");
  assert.equal(updated.assignee, "Local Agent");
  assert.equal(updated.assigneeAgentKey, "local/agent");
  assert.equal(updated.prUrl, "https://github.com/BrosInCode/letagents/pull/1");
  assert.equal(updated.workflowArtifacts?.[0]?.provider, "git");
  assert.equal(
    (await getLocalRoomArtifacts("task_room", { taskId: task.id })).artifacts?.[0]?.identity_key,
    "git:commit:id:def456",
  );

  await updateLocalTask("task_room", task.id, {
    workflowArtifacts: [],
  });
  assert.deepEqual((await getLocalRoomArtifacts("task_room", { taskId: task.id })).artifacts, []);
  await assert.rejects(
    () => updateLocalTask("task_room", task.id, {
      workflowArtifacts: [{
        provider: "git",
        kind: "invalid",
        id: "bad",
      } as any],
    }),
    /artifact.kind is invalid/,
  );
  assert.deepEqual((await getLocalTask("task_room", task.id))?.workflowArtifacts, []);

  assert.deepEqual((await listLocalTasks("task_room")).map((entry) => entry.id), [task.id]);
  assert.equal((await getLocalTask("task_room", task.id))?.status, "accepted");

  await assert.rejects(
    () => updateLocalTask("task_room", task.id, { status: "done" }),
    /Invalid transition: accepted -> done/,
  );
});

test("desktop local task import syncs workflow artifacts into shared artifacts", async () => {
  await createLocalRoom({
    roomIdentifier: "task_import_artifact_room",
    displayName: "Task Import Artifact Room",
  });
  await importLocalTasks("task_import_artifact_room", [{
    id: "task_9",
    title: "Imported task",
    description: null,
    status: "accepted",
    assignee: null,
    assigneeAgentKey: null,
    createdBy: "GitHub",
    prUrl: null,
    workflowArtifacts: [{
      provider: "git",
      kind: "commit",
      id: "import123",
      number: null,
      title: "Imported commit",
      url: null,
      ref: "feature/imported",
      state: null,
    }],
    workflowRefs: [],
    activeLeases: [],
    activeLocks: [],
    stalePromptState: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
  } satisfies DesktopTaskSummary]);

  const artifacts = await getLocalRoomArtifacts("task_import_artifact_room", { taskId: "task_9" });
  assert.equal(artifacts.artifacts?.[0]?.identity_key, "git:commit:id:import123");
  assert.deepEqual(artifacts.artifacts?.[0]?.linked_task_ids, ["task_9"]);
});

test("desktop local task reassignment clears stale agent session owner metadata", async () => {
  await createLocalRoom({
    roomIdentifier: "task_owner_handoff_room",
    displayName: "Task Owner Handoff Room",
  });
  const task = await addLocalTask("task_owner_handoff_room", {
    title: "Hand off local task",
  });
  await updateLocalTask("task_owner_handoff_room", task.id, { status: "accepted" });
  await updateLocalTask("task_owner_handoff_room", task.id, {
    status: "assigned",
    assignee: "Old Agent",
    assigneeAgentKey: "old/agent",
  });

  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      close: () => void;
      prepare: (sql: string) => {
        get: (...params: unknown[]) => Record<string, unknown> | undefined;
        run: (...params: unknown[]) => unknown;
      };
    };
  };
  const raw = new DatabaseSync(process.env.LETAGENTS_LOCAL_CHAT_DB || "");
  try {
    raw
      .prepare(`
        UPDATE local_tasks
        SET assignee_agent_instance_id = ?,
            assignee_agent_session_id = ?
        WHERE room_id = ? AND task_id = ?
      `)
      .run("old_instance", "old_session", "task_owner_handoff_room", task.id);

    await updateLocalTask("task_owner_handoff_room", task.id, {
      status: "in_progress",
    });
    const progressed = raw
      .prepare(`
        SELECT assignee_agent_instance_id, assignee_agent_session_id
        FROM local_tasks
        WHERE room_id = ? AND task_id = ?
      `)
      .get("task_owner_handoff_room", task.id);
    assert.equal(progressed?.assignee_agent_instance_id, "old_instance");
    assert.equal(progressed?.assignee_agent_session_id, "old_session");

    await updateLocalTask("task_owner_handoff_room", task.id, {
      assignee: "New Agent",
      assigneeAgentKey: "new/agent",
    });
    const reassigned = raw
      .prepare(`
        SELECT assignee_agent_key, assignee_agent_instance_id, assignee_agent_session_id
        FROM local_tasks
        WHERE room_id = ? AND task_id = ?
      `)
      .get("task_owner_handoff_room", task.id);
    assert.equal(reassigned?.assignee_agent_key, "new/agent");
    assert.equal(reassigned?.assignee_agent_instance_id, null);
    assert.equal(reassigned?.assignee_agent_session_id, null);
  } finally {
    raw.close();
  }
});

test("desktop local task publish claims prevent duplicate concurrent sync", async () => {
  await createLocalRoom({
    roomIdentifier: "publish_lock_room",
    displayName: "Publish Lock Room",
  });
  const task = await addLocalTask("publish_lock_room", {
    title: "Publish once",
  });

  const firstClaim = await claimLocalTasksForPublish("publish_lock_room");
  assert.deepEqual(firstClaim.map((entry) => entry.id), [task.id]);
  assert.deepEqual(await claimLocalTasksForPublish("publish_lock_room"), []);

  await releaseLocalTaskPublishClaim({
    roomId: "publish_lock_room",
    taskId: task.id,
  });
  assert.deepEqual(
    (await claimLocalTasksForPublish("publish_lock_room")).map((entry) => entry.id),
    [task.id],
  );

  await markLocalTaskSynced({
    roomId: "publish_lock_room",
    taskId: task.id,
    cloudTaskId: "task_99",
  });
  assert.deepEqual(await claimLocalTasksForPublish("publish_lock_room"), []);
});

test("desktop local task review leases are claimed and released locally", async () => {
  await createLocalRoom({
    roomIdentifier: "review_room",
    displayName: "Review Room",
  });
  const task = await addLocalTask("review_room", {
    title: "Review locally",
  });
  await updateLocalTask("review_room", task.id, { status: "accepted" });
  await updateLocalTask("review_room", task.id, {
    status: "assigned",
    assignee: "Local Worker",
    assigneeAgentKey: "local/worker",
  });
  await updateLocalTask("review_room", task.id, { status: "in_review" });

  const claimed = await claimLocalTaskReviewLease("review_room", task.id, {
    holderLabel: "Local Reviewer",
    agentKey: "local/reviewer",
    agentSessionId: "local_session_1",
  });
  assert.equal(claimed.lease.kind, "review");
  assert.equal(claimed.lease.holderLabel, "Local Reviewer");
  assert.equal(claimed.task.activeLeases.length, 1);

  const released = await releaseLocalTaskReviewLease("review_room", task.id, {
    leaseId: claimed.lease.id,
  });
  assert.equal(released.releasedLease?.status, "released");
  assert.deepEqual(released.task.activeLeases, []);
});

test("desktop local task review leases reject tasks outside review states", async () => {
  await createLocalRoom({
    roomIdentifier: "review_status_room",
    displayName: "Review Status Room",
  });
  const task = await addLocalTask("review_status_room", {
    title: "Not ready for review",
  });

  await assert.rejects(
    () => claimLocalTaskReviewLease("review_status_room", task.id, {
      holderLabel: "Local Reviewer",
      agentKey: "local/reviewer",
      agentSessionId: "local_session_status",
    }),
    /Cannot assign review authority while task is proposed/,
  );
});

test("desktop local task review leases reject the assigned worker", async () => {
  await createLocalRoom({
    roomIdentifier: "review_assignee_room",
    displayName: "Review Assignee Room",
  });
  const task = await addLocalTask("review_assignee_room", {
    title: "Review by someone else",
  });
  await updateLocalTask("review_assignee_room", task.id, {
    status: "accepted",
  });
  await updateLocalTask("review_assignee_room", task.id, {
    status: "assigned",
    assignee: "Local Worker",
    assigneeAgentKey: "local/worker",
  });
  await updateLocalTask("review_assignee_room", task.id, { status: "in_review" });

  await assert.rejects(
    () => claimLocalTaskReviewLease("review_assignee_room", task.id, {
      holderLabel: "Local Worker",
      agentKey: "local/worker",
      agentSessionId: "local_session_2",
    }),
    /cannot also claim review authority/,
  );
});

test("desktop and MCP local chat writers allocate unique ids across processes", async () => {
  const writers = Array.from({ length: 8 }, (_, index) => {
    const modulePath = pathToFileURL(
      join(
        repoRoot,
        index % 2 === 0
          ? "apps/desktop/electron/main/rooms/messages/local-store.ts"
          : "src/mcp/local-state/local-chat.ts",
      ),
    ).href;
    const code = `
      const { addLocalChatMessage } = await import(${JSON.stringify(modulePath)});
      const message = await addLocalChatMessage("room_race", {
        sender: "writer_${index}",
        text: "message_${index}",
        source: "agent"
      });
      console.log(message.id);
    `;
    return execFileAsync(process.execPath, ["--import", "tsx", "-e", code], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LETAGENTS_CHAT_STORAGE_SETTINGS_PATH: join(tempDir, `chat-storage-${index}.json`),
        LETAGENTS_LOCAL_CHAT_DB: process.env.LETAGENTS_LOCAL_CHAT_DB,
      },
    });
  });
  const results = await Promise.all(writers);
  const ids = results.map((result) => result.stdout.trim()).sort((left, right) => {
    return Number(left.replace("msg_", "")) - Number(right.replace("msg_", ""));
  });
  assert.deepEqual(ids, ["msg_1", "msg_2", "msg_3", "msg_4", "msg_5", "msg_6", "msg_7", "msg_8"]);
  assert.equal(
    await getLocalChatRoomWriteSequenceValue("room_race"),
    8,
    "Desktop and MCP writers share the same durable cross-process signal",
  );
});

test("local chat stores keep quote-replies top-level across a process restart", async () => {
  // Regression guard for the removed thread-root backfill: a bare quote-reply
  // (reply_to only, no explicit thread root) must stay top-level even after the
  // store is reopened in a fresh process — the backfill used to re-thread it on
  // init, undoing the quote-reply fix on local rooms across every restart.
  const stores = [
    { name: "desktop", module: "apps/desktop/electron/main/rooms/messages/local-store.ts" },
    { name: "mcp", module: "src/mcp/local-state/local-chat.ts" },
  ];

  for (const store of stores) {
    const moduleUrl = pathToFileURL(join(repoRoot, store.module)).href;
    const childEnv = {
      ...process.env,
      LETAGENTS_CHAT_STORAGE_SETTINGS_PATH: join(tempDir, `restart-${store.name}-storage.json`),
      LETAGENTS_LOCAL_CHAT_DB: join(tempDir, `restart-${store.name}.sqlite`),
    };

    // Process 1: root, a bare quote-reply, and an explicit thread reply.
    const writeCode = `
      const { addLocalChatMessage } = await import(${JSON.stringify(moduleUrl)});
      const root = await addLocalChatMessage("restart_room", {
        sender: "Human", text: "root", source: "browser",
      });
      await addLocalChatMessage("restart_room", {
        sender: "Agent", text: "quote reply", source: "agent", reply_to: root.id,
      });
      await addLocalChatMessage("restart_room", {
        sender: "Agent", text: "thread reply", source: "agent",
        reply_to: root.id, thread_root_id: root.id,
      });
      console.log("written");
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "-e", writeCode], {
      cwd: process.cwd(),
      env: childEnv,
    });

    // Process 2 (a fresh process == an app/server restart): opening the store
    // runs schema init, then we read the raw thread roots straight from SQLite.
    const readCode = `
      const { getLocalChatMessages } = await import(${JSON.stringify(moduleUrl)});
      await getLocalChatMessages("restart_room");
      const { DatabaseSync } = await import("node:sqlite");
      const raw = new DatabaseSync(process.env.LETAGENTS_LOCAL_CHAT_DB);
      const rows = raw
        .prepare("SELECT number, reply_to_number, thread_root_number FROM local_chat_messages WHERE room_id = ? ORDER BY number ASC")
        .all("restart_room");
      console.log(JSON.stringify(rows.map((row) => ({
        number: Number(row.number),
        reply_to_number: row.reply_to_number == null ? null : Number(row.reply_to_number),
        thread_root_number: row.thread_root_number == null ? null : Number(row.thread_root_number),
      }))));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "-e", readCode], {
      cwd: process.cwd(),
      env: childEnv,
    });

    assert.deepEqual(
      JSON.parse(stdout.trim()),
      [
        { number: 1, reply_to_number: null, thread_root_number: null },
        // quote reply: reply reference kept, NOT threaded — and it stays that
        // way after the restart (no backfill re-threads it).
        { number: 2, reply_to_number: 1, thread_root_number: null },
        // explicit thread reply: remains threaded onto the root.
        { number: 3, reply_to_number: 1, thread_root_number: 1 },
      ],
      `store ${store.name} must not re-thread a quote-reply across restart`,
    );
  }
});
