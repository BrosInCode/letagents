import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const serverDirectory = join(testDirectory, "../server");
const bridgeDirectory = join(serverDirectory, "event-bridge");

const domainDeclarations = {
  constants: [
    "ROOM_EVENT_CHANNEL:export",
    "LISTEN_RECONNECT_DELAY_MS:export",
    "MAX_INLINE_DATA_BYTES:export",
    "MAX_NOTIFICATION_ORIGINS:export",
    "MAX_QUEUED_NOTIFICATIONS_PER_ORIGIN:export",
    "MAX_OUTSTANDING_NOTIFICATIONS:export",
    "NOTIFICATION_QUEUE_DEADLINE_MS:export",
    "BRIDGE_PUBLISH_STATEMENT_TIMEOUT_MS:export",
    "BRIDGE_CLIENT_ACQUIRE_TIMEOUT_MS:export",
    "MAX_BRIDGE_ROOM_ID_BYTES:export",
  ],
  "envelope-codec": [
    "instanceId:export",
    "InlineBridgeEnvelope:private",
    "RefBridgeEnvelope:private",
    "BridgeLossMarker:export",
    "LossBridgeEnvelope:export",
    "BridgeEnvelope:export",
    "ParsedBridgeEnvelope:export",
    "RefBuilder:private",
    "RefHydrator:private",
    "asRecord:export",
    "stringField:private",
    "roomIdField:export",
    "roomIdFromBridgeValue:export",
    "REF_BUILDERS:private",
    "REF_HYDRATORS:export",
    "buildBridgeEnvelope:export",
    "roomIdFromParsedEnvelope:export",
    "hasMalformedRoomId:export",
  ],
  listener: [
    "listenerClient:private",
    "listenerConnectWork:private",
    "listenerNotificationReceiver:private",
    "detachListenerClientEvents:private",
    "reconnectTimer:private",
    "stopped:private",
    "bridgeGeneration:private",
    "startBridgeListener:export",
    "startListenerConnect:private",
    "beginStopBridgeListener:export",
    "finishStopBridgeListener:export",
    "connectListener:private",
    "recoverListener:private",
    "scheduleReconnect:private",
    "parseNotificationPayload:private",
  ],
  "loss-signals": [
    "lossEpoch:private",
    "roomEventBridgeLifecycleEvents:export",
    "reportBridgeLoss:export",
  ],
  "notification-dispatch": [
    "roomInterestPredicate:private",
    "observedRemoteLosses:private",
    "MAX_OBSERVED_REMOTE_LOSSES:private",
    "setRoomEventBridgeInterestPredicate:export",
    "applyRemoteBridgeLoss:private",
    "dispatchBridgeNotification:export",
    "runBridgeHydration:private",
  ],
  "ordered-notification-receiver": [
    "OrderedNotificationWork:private",
    "OrderedNotificationLane:private",
    "OrderedBridgeNotificationReceiver:export",
    "createOrderedBridgeNotificationReceiver:export",
  ],
  publisher: [
    "lossRetryTimer:private",
    "stopped:private",
    "bridgeActive:private",
    "pendingRoomLosses:private",
    "pendingGlobalLossEpoch:private",
    "inFlightPublishes:private",
    "activeBridgePublishOperations:private",
    "MAX_PENDING_ROOM_LOSSES:private",
    "reportPublisherBridgeLoss:private",
    "publishBridgedEvent:private",
    "publishBridgeEnvelope:private",
    "runBridgePublish:private",
    "queuePendingBridgeLoss:private",
    "snapshotPendingBridgeLosses:private",
    "clearPendingBridgeLosses:private",
    "scheduleBridgeLossRetry:export",
    "trackBridgePublish:private",
    "executeBridgePublish:export",
    "queryBridgeClient:export",
    "flushPendingBridgeLosses:private",
    "startBridgePublisher:export",
    "beginStopBridgePublisher:export",
    "finishStopBridgePublisher:export",
  ],
} as const;

function topLevelDeclarationInventory(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory: string[] = [];
  for (const statement of sourceFile.statements) {
    const visibility = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ? "export" : "private";
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        inventory.push(`${declaration.name.getText(sourceFile)}:${visibility}`);
      }
      continue;
    }
    if ((ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)) && statement.name) {
      inventory.push(`${statement.name.text}:${visibility}`);
    }
  }
  return inventory;
}

function facadeExportInventory(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause
      && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        inventory.push(
          `${element.name.text}:${statement.isTypeOnly || element.isTypeOnly ? "type" : "value"}`,
        );
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      inventory.push(`${statement.name.text}:value`);
    }
  }
  return inventory;
}

test("event-bridge.ts remains a bounded compatibility facade and coordinator", async () => {
  const source = readFileSync(join(serverDirectory, "event-bridge.ts"), "utf8");
  assert.ok(source.split("\n").length <= 60, "the facade must stay small");
  assert.doesNotMatch(source, /from ["']\.\.\/db/, "the facade must not own persistence");
  assert.match(
    source,
    /if \(!startBridgePublisher\(\)\) \{\s*return;\s*\}\s*startBridgeListener\(\);/,
    "listener startup must remain conditional on the idempotent publisher start",
  );
  assert.match(
    source,
    /beginStopBridgePublisher\(\);\s*beginStopBridgeListener\(\);\s*await finishStopBridgePublisher\(\);\s*await finishStopBridgeListener\(\);/,
    "shutdown must synchronously fence both domains before draining publisher then listener work",
  );
  assert.deepEqual(facadeExportInventory("event-bridge.ts", source), [
    "BridgedEventEmitter:value",
    "createBridgedEmitter:value",
    "roomEventBridgeLossEvents:value",
    "buildBridgeEnvelope:value",
    "BridgeEnvelope:type",
    "dispatchBridgeNotification:value",
    "setRoomEventBridgeInterestPredicate:value",
    "createOrderedBridgeNotificationReceiver:value",
    "OrderedBridgeNotificationReceiver:type",
    "roomEventBridgeLifecycleEvents:value",
    "executeBridgePublish:value",
    "startRoomEventBridge:value",
    "stopRoomEventBridge:value",
  ]);

  const facade = await import("../server/event-bridge.js");
  assert.deepEqual(Object.keys(facade).sort(), [
    "BridgedEventEmitter",
    "buildBridgeEnvelope",
    "createBridgedEmitter",
    "createOrderedBridgeNotificationReceiver",
    "dispatchBridgeNotification",
    "executeBridgePublish",
    "roomEventBridgeLifecycleEvents",
    "roomEventBridgeLossEvents",
    "setRoomEventBridgeInterestPredicate",
    "startRoomEventBridge",
    "stopRoomEventBridge",
  ]);
});

test("every event-bridge declaration keeps its exact bounded-domain owner and visibility", () => {
  for (const [domain, expected] of Object.entries(domainDeclarations)) {
    const source = readFileSync(join(bridgeDirectory, `${domain}.ts`), "utf8");
    assert.deepEqual(
      topLevelDeclarationInventory(`${domain}.ts`, source),
      expected,
      `${domain} declaration ownership, order, or visibility changed`,
    );
  }
});

test("event-bridge domains form an acyclic graph and never import the facade", () => {
  const graph = new Map<string, string[]>();
  const domains = new Set(Object.keys(domainDeclarations));
  for (const domain of domains) {
    const source = readFileSync(join(bridgeDirectory, `${domain}.ts`), "utf8");
    assert.doesNotMatch(source, /from ["']\.\.\/event-bridge\.js["']/);
    const dependencies = [...source.matchAll(/from ["']\.\/([^"']+)\.js["']/g)]
      .map((match) => match[1])
      .filter((dependency) => domains.has(dependency));
    graph.set(domain, dependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (domain: string) => {
    assert.ok(!visiting.has(domain), `event-bridge import cycle reaches ${domain}`);
    if (visited.has(domain)) return;
    visiting.add(domain);
    for (const dependency of graph.get(domain) ?? []) visit(dependency);
    visiting.delete(domain);
    visited.add(domain);
  };
  for (const domain of domains) visit(domain);
});

test("the facade preserves direct runtime identities for extracted public operations", async () => {
  const facade = await import("../server/event-bridge.js");
  const bridgedEmitter = await import("../server/bridged-emitter.js");
  const envelope = await import("../server/event-bridge/envelope-codec.js");
  const dispatch = await import("../server/event-bridge/notification-dispatch.js");
  const receiver = await import("../server/event-bridge/ordered-notification-receiver.js");
  const signals = await import("../server/event-bridge/loss-signals.js");
  const publisher = await import("../server/event-bridge/publisher.js");

  for (const [name, implementation] of Object.entries({
    BridgedEventEmitter: bridgedEmitter.BridgedEventEmitter,
    createBridgedEmitter: bridgedEmitter.createBridgedEmitter,
    roomEventBridgeLossEvents: bridgedEmitter.roomEventBridgeLossEvents,
    buildBridgeEnvelope: envelope.buildBridgeEnvelope,
    dispatchBridgeNotification: dispatch.dispatchBridgeNotification,
    setRoomEventBridgeInterestPredicate: dispatch.setRoomEventBridgeInterestPredicate,
    createOrderedBridgeNotificationReceiver: receiver.createOrderedBridgeNotificationReceiver,
    roomEventBridgeLifecycleEvents: signals.roomEventBridgeLifecycleEvents,
    executeBridgePublish: publisher.executeBridgePublish,
  })) {
    assert.strictEqual(facade[name], implementation, `${name} must be a direct facade re-export`);
  }
});

test("loss reporting returns its own epoch across synchronous reentrant listeners", async () => {
  const { roomEventBridgeLossEvents } = await import("../server/bridged-emitter.js");
  const { reportBridgeLoss } = await import("../server/event-bridge/loss-signals.js");
  const observedEpochs: number[] = [];
  let reentered = false;
  const listener = (event: { epoch: number }) => {
    observedEpochs.push(event.epoch);
    if (!reentered) {
      reentered = true;
      reportBridgeLoss("nested_test_loss");
    }
  };
  roomEventBridgeLossEvents.on("loss", listener);
  try {
    const outerEpoch = reportBridgeLoss("outer_test_loss");
    assert.equal(outerEpoch, observedEpochs[0]);
    assert.ok(observedEpochs[1] > outerEpoch);
  } finally {
    roomEventBridgeLossEvents.off("loss", listener);
  }
});
