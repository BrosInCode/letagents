import "./isolated-home.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { supervisedAgentTest as test } from "./platform.js";
import {
  CURSOR_NO_ROOM_REPLY_SENTINEL,
  CursorProviderAdapter,
  defaultLaunchTurn,
  type CursorCliChild,
  type CursorProviderAdapterDependencies,
} from "../main/agents/cursor-provider-adapter.js";
import type { ProviderRoomTurnResult, ProviderTerminalPayload } from "../main/agents/provider-adapter.js";
import { relocateCursorConversationNamespace } from "../main/agents/cursor-managed-profile.js";
import { cursorAuthorityUnprovenDetail } from "../main/agents/cursor-turn-settlement.js";
import {
  productionPersonalIdentityDependencies,
  wrapperHostedMcpFixture,
  materializeAttestableMcpRuntime,
  wrapperMcpRuntimeEnv,
  createHarness,
  daemonSpawnRequest,
  spawnDaemonLane,
  roomTurnRequest,
  flush,
  waitForPath,
  waitFor,
  withLoopAlive,
  runTurnWithWrapperTerminal,
  unprovenAuthorityTerminal,
} from "./cursor-provider-adapter.fixture.js";

test("Cursor keeps a durable no-reply journal until fallible workspace receipt cleanup succeeds in run and recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-cleanup-order-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const harness = createHarness();
    let removalAttempts = 0;
    const adapter = new CursorProviderAdapter({
      dependencies: {
        ...harness.dependencies,
        async removeWorkspaceGenerationReceipt() {
          removalAttempts += 1;
          throw new Error(`injected receipt cleanup failure ${removalAttempts}`);
        },
      },
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: join(root, "home"), NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await spawnDaemonLane(adapter, harness, daemonSpawnRequest({
      cwd: root,
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    let turnId = "";
    const run = adapter.runRoomTurn(handle, roomTurnRequest({ actionId: "cleanup-order" }), {
      checkpointTurnStarted: async (value) => { turnId = value; },
      checkpointTerminalResult: async (raw) => ({
        acceptedResult: raw,
        cleanupRecoveryEvidence: true,
      }),
    });
    await waitFor(() => harness.children[0]?.isReleased === true);
    const launch = harness.launches[0]!;
    const sessionId = "sess-cursor-1";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    const result = {
      type: "result", subtype: "success", is_error: false,
      result: CURSOR_NO_ROOM_REPLY_SENTINEL, session_id: sessionId,
    };
    writeFileSync(statePath, [
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
      JSON.stringify(result),
      "",
    ].join("\n"));
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit", code: 0, signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      turn_contract_version: 1,
      session_contract_valid: true,
      stream_contract_complete: true,
      workspace_generation_manifest_path: launch.workspaceGenerationManifestPath,
      init: { type: "system", subtype: "init", session_id: sessionId },
      result,
    }));
    harness.children[0]!.emit(result);
    harness.children[0]!.resolveExit({ type: "exit", code: 0, signal: null });
    await assert.rejects(run, /injected receipt cleanup failure 1/);
    assert.equal(existsSync(`${statePath}.terminal.json`), true,
      "run cleanup failure leaves the only restart-readable terminal journal intact");

    await assert.rejects(adapter.recoverRoomTurn(handle, {
      inboxItemId: "cleanup-order", providerTurnId: turnId,
    }, {
      checkpointTerminalResult: async (raw) => ({ acceptedResult: raw, cleanupRecoveryEvidence: true }),
    }), /injected receipt cleanup failure 2/);
    assert.equal(existsSync(`${statePath}.terminal.json`), true,
      "recovery cleanup failure also leaves the no-reply journal intact");

    const retried = await adapter.recoverRoomTurn(handle, {
      inboxItemId: "cleanup-order", providerTurnId: turnId,
    });
    assert.equal(retried.outcome, "no_reply");
    assert.equal(removalAttempts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successor recovers the exact Cursor reply from the private wrapper journal without redispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-turn-recovery-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:durable-restart-turn";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    writeFileSync(statePath, [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-after-restart" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "reply recovered after handoff", session_id: "sess-after-restart" }),
      "",
    ].join("\n"));
    const harness = createHarness();
    const generation = await harness.dependencies.createWorkspaceGeneration({ realWorkspace: root, turnIdentity: turnId });
    harness.workspaceGenerationEvents.length = 0;
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit", code: 0, signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      workspace_generation_manifest_path: generation.manifestPath,
      init: { type: "system", subtype: "init", session_id: "sess-after-restart" },
      result: { type: "result", subtype: "success", is_error: false, result: "reply recovered after handoff", session_id: "sess-after-restart", request_id: null },
    }));
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: ({ workAttemptId }) => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: join(root, "home"), NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest({ cwd: root });
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: "sess-after-restart",
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    let checkpointed = false;
    const recovered = await adapter.recoverRoomTurn(handle, {
      inboxItemId: "inbox-after-restart",
      providerTurnId: turnId,
    }, {
      checkpointProviderState: async (state) => {
        checkpointed = true;
        assert.equal(state.providerConnection.pid, null);
      },
    });
    assert.deepEqual(recovered, {
      turnId, outcome: "reply", text: "reply recovered after handoff", evidence: "stream",
      publicationContract: "structured_room_turn_v1",
    });
    assert.equal(checkpointed, true);
    assert.equal(harness.launches.length, 0, "recovery never starts another native turn");
    assert.deepEqual(harness.workspaceGenerationEvents.map((event) => event.kind), ["recover"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const startingContinuation of ["sess-cursor-1", "cursor-pending:unproven-restart"]) {
test(`a successor still refuses a wrapper journal whose remote authority was never proven revoked (${startingContinuation.startsWith("cursor-pending") ? "pending" : "established"} conversation)`, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-turn-recovery-unproven-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:unproven-restart-turn";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    writeFileSync(statePath, "");
    const harness = createHarness();
    const generation = await harness.dependencies.createWorkspaceGeneration({ realWorkspace: root, turnIdentity: turnId });
    harness.workspaceGenerationEvents.length = 0;
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify(unprovenAuthorityTerminal(
      { workspaceGenerationManifestPath: generation.manifestPath },
      { remote_authority_failed_checks: ["proxy_sockets", "runtime_data", "proxy_sockets"] }, "reply that must not be published",
    )));
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: join(root, "home"), NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest({ cwd: root });
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: startingContinuation,
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    await assert.rejects(
      adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-unproven-restart", providerTurnId: turnId }),
      (error: unknown) => (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "ambiguous"
        && /remote-authority revocation\. Wrapper checks that failed: proxy_sockets, runtime_data\.$/.test((error as Error).message),
    );
    assert.deepEqual(harness.workspaceGenerationEvents, [], "recovery never reconciles a generation without containment proof");
    assert.equal(handle.providerContinuationId, startingContinuation, "an unproven terminal never rewrites the lane's conversation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
}

test("Cursor recommits a visible settlement before cleanup after a failed directory sync", async (t) => {
  for (const phase of ["cleaned", "aborted", "before-loan", "fresh-aborted"] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "letagents-cursor-settlement-sync-")));
    const originalSync = fs.fsyncSync;
    try {
      const workspace = join(root, "workspace");
      const live = join(root, "live");
      const configDir = join(root, "config");
      mkdirSync(workspace);
      mkdirSync(live);
      mkdirSync(configDir);
      const turnId = `cursor:settlement-${phase}`;
      const terminalPath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl.terminal.json`);
      const harness = createHarness();
      const generation = { ...await harness.dependencies.createWorkspaceGeneration({ realWorkspace: workspace, turnIdentity: turnId }), liveWorkspace: live };
      let generationAvailable = true;
      let removals = 0;
      let successfulMarkerParentSyncs = 0;
      let failSync = true;
      const profile = { homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"), env: { HOME: join(root, "home") } };
      const makeAdapter = () => new CursorProviderAdapter({
        dependencies: {
          ...harness.dependencies,
          relocateConversationNamespace: relocateCursorConversationNamespace,
          async openWorkspaceGeneration() {
            assert.equal(generationAvailable, true, "a settled terminal must not require a removed receipt");
            return generation;
          },
          async removeWorkspaceGenerationReceipt() {
            assert.ok(successfulMarkerParentSyncs > 0, "marker durability precedes every removal");
            generationAvailable = false;
            removals += 1;
            if (removals === 1) throw new Error("crash after receipt removal");
          },
        },
        supervisedProfileFactory: () => profile,
      });
      const adapter = makeAdapter();
      const request = daemonSpawnRequest({ cwd: workspace });
      const initial = phase === "fresh-aborted" ? await adapter.spawn(request) : null;
      const session = initial?.providerContinuationId ?? "sess-sync-recovery";
      const handle = initial ?? await adapter.resume({
        workAttemptId: request.workAttemptId, providerContinuationId: session,
        providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
      }, request);
      const storeAt = (cwd: string) => join(configDir, "cursor", "chats", createHash("md5").update(cwd).digest("hex"), session, "store.db");
      if (phase !== "fresh-aborted") {
        const initialStore = storeAt(phase === "before-loan" ? workspace : live);
        mkdirSync(dirname(initialStore), { recursive: true });
        writeFileSync(initialStore, "original conversation");
      }
      writeFileSync(terminalPath, JSON.stringify({
        type: phase === "cleaned" ? "exit" : "not_started", code: 0, signal: null,
        native_process_group_reaped: true, reap_scope: "native_process_group", remote_authority_revoked: true,
        session_contract_valid: true, stream_contract_complete: true, turn_contract_version: 1,
        workspace_generation_manifest_path: generation.manifestPath,
        init: phase === "cleaned" ? { type: "system", subtype: "init", session_id: session } : null,
        result: phase === "cleaned" ? { type: "result", subtype: "success", is_error: false, result: "preserved", session_id: session } : null,
      }));
      const syncMock = t.mock.method(fs, "fsyncSync", (fd: number) => {
        const isMarkerParent = fs.fstatSync(fd).isDirectory()
          && fs.fstatSync(fd).ino === fs.statSync(configDir).ino
          && JSON.parse(readFileSync(terminalPath, "utf8")).workspace_generation_settlement;
        if (isMarkerParent && failSync) { failSync = false; throw new Error("injected marker parent sync failure"); }
        originalSync(fd);
        if (isMarkerParent) successfulMarkerParentSyncs += 1;
      });
      syncBuiltinESMExports();
      const recovery = { inboxItemId: "settlement", providerTurnId: turnId };
      const checkpoint = { checkpointTerminalResult: async (raw: ProviderRoomTurnResult) => ({ acceptedResult: raw, cleanupRecoveryEvidence: true }) };
      await assert.rejects(adapter.recoverRoomTurn(handle, recovery, checkpoint), /injected marker parent sync failure/);
      assert.equal(removals, 0);
      assert.equal(successfulMarkerParentSyncs, 0);
      assert.equal(JSON.parse(readFileSync(terminalPath, "utf8")).workspace_generation_settlement.phase, phase === "cleaned" ? "cleaned" : "aborted");
      if (phase !== "fresh-aborted") assert.equal(readFileSync(storeAt(workspace), "utf8"), "original conversation");
      const markedTerminal = readFileSync(terminalPath, "utf8");
      for (const invalid of [{ version: 2 }, { phase: "unknown" }, { provider_continuation_id: "another-session" }]) {
        const raw = JSON.parse(markedTerminal);
        raw.workspace_generation_settlement = { ...raw.workspace_generation_settlement, ...invalid };
        writeFileSync(terminalPath, JSON.stringify(raw));
        await assert.rejects(adapter.recoverRoomTurn(handle, recovery, checkpoint), /settlement evidence is invalid/);
        assert.equal(removals, 0);
      }
      writeFileSync(terminalPath, markedTerminal);
      if (phase !== "fresh-aborted") {
        fs.renameSync(storeAt(workspace), `${storeAt(workspace)}.held`);
        await assert.rejects(adapter.recoverRoomTurn(handle, recovery, checkpoint), /exact session store/);
        assert.equal(removals, 0);
        fs.renameSync(`${storeAt(workspace)}.held`, storeAt(workspace));
      }
      await assert.rejects(adapter.recoverRoomTurn(handle, recovery, checkpoint), /crash after receipt removal/);
      assert.equal(generationAvailable, false);
      const successor = makeAdapter();
      const resumed = await successor.resume({ workAttemptId: request.workAttemptId, providerContinuationId: session,
        providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null } }, request);
      if (phase === "cleaned") {
        assert.equal((await successor.recoverRoomTurn(resumed, recovery, checkpoint)).text, "preserved");
        assert.equal(existsSync(terminalPath), false);
      } else {
        await assert.rejects(successor.recoverRoomTurn(resumed, recovery, checkpoint),
          (error: unknown) => (error as { roomTurnRecoveryOutcome?: string }).roomTurnRecoveryOutcome === "not_dispatched");
        assert.equal(existsSync(terminalPath), true, "undispatched evidence remains until the daemon resets that exact turn");
      }
      assert.equal(removals, 2);
      assert.equal(harness.launches.length, 0);
      syncMock.mock.restore();
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a successor marks pre-version legacy durable Cursor results for the bounded aggregate fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-legacy-turn-recovery-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:legacy-durable-turn";
    const sessionId = "sess-legacy-restart";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    const legacyResult = { type: "result", is_error: false, result: "legacy aggregate reply", session_id: sessionId };
    writeFileSync(statePath, [
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
      JSON.stringify(legacyResult),
      "",
    ].join("\n"));
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit", code: 0, signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      init: { type: "system", subtype: "init", session_id: sessionId },
      result: legacyResult,
    }));
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: join(root, "home"), NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest();
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: sessionId,
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    assert.deepEqual(await adapter.recoverRoomTurn(handle, {
      inboxItemId: "inbox-legacy-restart", providerTurnId: turnId,
    }), {
      turnId, outcome: "reply", text: "legacy aggregate reply", evidence: "stream",
      publicationContract: "legacy_cursor_aggregate_v0",
    });
    assert.equal(harness.launches.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successor materializes a trusted durable no-result terminal on the recovered lane", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-turn-terminal-recovery-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:durable-terminal-turn";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    writeFileSync(statePath, `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-terminal-restart" })}\n`);
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit", code: 9, signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      init: { type: "system", subtype: "init", session_id: "sess-terminal-restart" },
      result: null,
    }));
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest();
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: "sess-terminal-restart",
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, (terminal) => terminals.push(terminal));

    const settled: string[] = [];
    const recovered = await adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-terminal-restart", providerTurnId: turnId }, {
      checkpointProviderState: async () => {
        assert.equal(terminals.length, 0, "recovered continuation checkpoints before onExit retires the live handle");
      },
      checkpointTerminalResult: async (result) => {
        assert.equal(terminals.length, 0, "the crashed turn settles before onExit retires the live handle");
        settled.push(result.outcome);
        return { acceptedResult: result, cleanupRecoveryEvidence: false };
      },
    });
    assert.equal(recovered.outcome, "interrupted", "a proven crash settles the turn instead of blocking delivery");
    assert.equal(recovered.providerContinuationId, "sess-terminal-restart");
    assert.match(recovered.error ?? "", /ended before the bounded room turn produced a terminal result/);
    assert.deepEqual(settled, ["interrupted"]);
    assert.equal(handle.observedState(), "failed");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.terminalCause, "crashed");
    assert.equal(terminals[0]!.exitCode, 9);
    assert.equal(harness.launches.length, 0, "terminal recovery never launches another native turn");
    assert.equal(
      (await adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-terminal-restart", providerTurnId: turnId })).outcome,
      "interrupted",
    );
    assert.equal(terminals.length, 1, "repeated recovery never emits a duplicate exit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor recovery rejects legacy terminal evidence that did not separately prove authority revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-legacy-terminal-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:legacy-terminal";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    writeFileSync(statePath, "");
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit", code: 0, signal: null,
      descendants_reaped: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      init: { type: "system", subtype: "init", session_id: "sess-legacy" },
      result: { type: "result", is_error: false, result: "must not recover", session_id: "sess-legacy" },
    }));
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest();
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: "sess-legacy",
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    await assert.rejects(
      adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-legacy", providerTurnId: turnId }),
      /does not prove native process-group retirement and remote-authority revocation/,
    );
    assert.equal(harness.launches.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor recovery distinguishes a prepared wrapper that never dispatched native work", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-not-dispatched-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:prepared-only";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    writeFileSync(statePath, "");
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "not_started",
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      init: null,
      result: null,
    }));
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest();
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: "sess-safe",
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    await assert.rejects(
      adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-prepared", providerTurnId: turnId }),
      (error: unknown) => (error as { roomTurnRecoveryOutcome?: unknown }).roomTurnRecoveryOutcome === "not_dispatched",
    );
    assert.equal(harness.launches.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor recovery rejects a terminal snapshot cross-wired to another session", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-session-contract-"));
  try {
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const turnId = "cursor:cross-wired";
    const statePath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl`);
    writeFileSync(statePath, "");
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit", code: 0, signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      init: { type: "system", subtype: "init", session_id: "sess-stranger" },
      result: { type: "result", is_error: false, result: "wrong", session_id: "sess-stranger" },
    }));
    const harness = createHarness();
    const adapter = new CursorProviderAdapter({
      dependencies: harness.dependencies,
      supervisedProfileFactory: () => ({
        homeDir: join(root, "home"), configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { NPM_CONFIG_CACHE: join(root, "npm-cache") },
      }),
    });
    const request = daemonSpawnRequest();
    const handle = await adapter.resume({
      workAttemptId: request.workAttemptId,
      providerContinuationId: "sess-established",
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    await assert.rejects(
      adapter.recoverRoomTurn(handle, { inboxItemId: "inbox-cross-wired", providerTurnId: turnId }),
      /different provider continuation/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production Cursor wrapper remains native group leader and writes restart-readable terminal evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-wrapper-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
const resume = args.find((arg) => arg.startsWith("--resume="));
const session = resume ? resume.slice("--resume=".length) : "sess-wrapper-" + process.ppid;
const tokenIndex = args.indexOf("--auth-token");
if (tokenIndex < 0 || !args[tokenIndex + 1]) process.exit(92);
fs.mkdirSync(process.env.HOME + "/.cursor", { recursive: true });
fs.writeFileSync(process.env.HOME + "/.cursor/auth.json", JSON.stringify({
  accessToken: args[tokenIndex + 1], refreshToken: args[tokenIndex + 1],
}));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "wrapper reply", session_id: session }) + "\\n");
    `);
    chmodSync(executable, 0o700);
    let runtimeDataDir = "";
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          runtimeDataDir = input.env?.CURSOR_DATA_DIR ?? "";
          return defaultLaunchTurn(input);
        },
      },
      supervisedProfileFactory: () => ({
        homeDir, configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: homeDir, NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const order: string[] = [];
    let wrapperPid: number | null = null;
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointTurnStarted: async () => { order.push("turn"); },
      checkpointProviderState: async (state) => {
        order.push(state.providerConnection.pid === null ? "idle" : "wrapper");
        if (state.providerConnection.pid !== null) wrapperPid = state.providerConnection.pid;
      },
    }));
    assert.equal(result.text, "wrapper reply");
    assert.deepEqual(order.slice(0, 2), ["turn", "wrapper"], "wrapper identity is durable before the fake Cursor executable is released");
    assert.equal(order.at(-1), "idle");
    assert.equal(handle.providerContinuationId, `sess-wrapper-${wrapperPid}`, "native Cursor shares the still-live wrapper's PGID");
    const terminalPath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(result.turnId).digest("hex")}.jsonl.terminal.json`);
    assert.equal(JSON.parse(readFileSync(terminalPath, "utf8")).remote_authority_revoked, true);
    assert.equal(existsSync(runtimeDataDir), false, "the wrapper retires private worker state before terminal acceptance");
    assert.equal(existsSync(join(homeDir, ".cursor", "auth.json")), false, "terminal publication purges the public file-store placeholder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal evidence honestly scopes reaping when a detached native child outlives revoked turn authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-detached-residual-"));
  const profileRoot = join(root, "private-profile");
  const configDir = join(profileRoot, "config");
  const homeDir = join(profileRoot, "home");
  const tempDir = join(profileRoot, "tmp");
  const statusPath = join(tempDir, "detached-status.json");
  const pidPath = join(tempDir, "detached.pid");
  const executable = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : ""; }
const escaped = spawn(process.execPath, ["-e", ${JSON.stringify(`
const fs = require("node:fs");
const http = require("node:http");
const [statusPath, endpoint] = process.argv.slice(1);
setTimeout(() => {
  let broadReadBlocked = false;
  try { fs.readdirSync("/usr/local"); } catch (error) { broadReadBlocked = error && (error.code === "EPERM" || error.code === "EACCES"); }
  const request = http.request(endpoint, { method: "POST" });
  let authorityRevoked = false;
  request.once("response", () => { authorityRevoked = false; finish(); });
  request.once("error", () => { authorityRevoked = true; finish(); });
  request.end();
  function finish() {
    fs.writeFileSync(statusPath, JSON.stringify({ broadReadBlocked, authorityRevoked, profileWriteStillPossible: true }));
    setInterval(() => {}, 1000);
  }
}, 350);
`)}, ${JSON.stringify(statusPath)}, value("--agent-endpoint")], {
  detached: true,
  // Keep the native stdout/stderr pipes open after the parent exits. Node's
  // ChildProcess close must remain pending while exit has already fired.
  stdio: ["ignore", "inherit", "inherit"],
  env: process.env,
});
escaped.unref();
fs.writeFileSync(${JSON.stringify(pidPath)}, String(escaped.pid));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-detached-residual" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "detached-boundary-recorded", session_id: "sess-detached-residual" }) + "\\n");
`);
  chmodSync(executable, 0o700);
  let escapedPid: number | null = null;
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalProfileRoot = realpathSync(profileRoot);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(profileRoot, "data"),
        cacheDir: join(profileRoot, "cache"),
        env: { HOME: homeDir, TMPDIR: tempDir },
        ...wrapperHostedMcpFixture(root),
        nativeAllowedWriteSubpaths: [profileRoot, canonicalProfileRoot],
        nativeAllowedReadSubpaths: [root, canonicalRoot],
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const pendingResult = withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(await waitForPath(pidPath), true, "the detached fixture publishes its process identity");
    escapedPid = Number(readFileSync(pidPath, "utf8"));
    assert.ok(Number.isSafeInteger(escapedPid) && escapedPid > 1);
    assert.equal(await waitForPath(statusPath), true, "the detached fixture publishes its post-exit probe");
    assert.deepEqual(JSON.parse(readFileSync(statusPath, "utf8")), {
      broadReadBlocked: process.platform === "darwin",
      authorityRevoked: true,
      profileWriteStillPossible: true,
    });
    assert.doesNotThrow(() => process.kill(escapedPid!, 0), "the detached setsid child is an explicit operational residual");
    process.kill(escapedPid, "SIGKILL");
    const result = await pendingResult;
    const terminalPath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(result.turnId).digest("hex")}.jsonl.terminal.json`);
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    assert.equal(terminal.descendants_reaped, undefined, "terminal evidence never overclaims complete descendant reaping");
    assert.equal(terminal.native_process_group_reaped, true);
    assert.equal(terminal.reap_scope, "native_process_group");
    assert.equal(terminal.remote_authority_revoked, true);
  } finally {
    if (escapedPid && Number.isSafeInteger(escapedPid)) {
      try { process.kill(escapedPid, "SIGKILL"); } catch {}
      for (let index = 0; index < 50; index += 1) {
        try { process.kill(escapedPid, 0); await flush(); }
        catch { break; }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGTERM at every async wrapper startup boundary cannot publish not_started beside later native work", async () => {
  for (const stage of ["mcp_listen", "authority_listen", "agent_listen"] as const) {
    const root = mkdtempSync("/tmp/letagents-cursor-startup-barrier-");
    const barrierPath = join(root, stage);
    const statePath = join(root, "turn.jsonl");
    const nativeMarker = join(root, "native-launched");
    const executable = join(root, "fake-cursor-agent");
    const connectorRoot = join("/tmp", `letagents-cursor-mcp-${randomUUID()}`);
    const runtimeDataRoot = mkdtempSync("/tmp/letagents-cursor-data-");
    writeFileSync(statePath, "");
    writeFileSync(executable, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(nativeMarker)}, "launched\\n");\nsetInterval(() => {}, 1000);\n`);
    chmodSync(executable, 0o700);
    const mcpRuntimeEnv = wrapperMcpRuntimeEnv(connectorRoot, `cursor:startup-race-${stage}`);
    let child: CursorCliChild | null = null;
    try {
      child = defaultLaunchTurn({
        cursorBin: executable,
        args: ["-p", "--output-format", "stream-json", "startup race"],
        cwd: root,
        env: {
          HOME: join(root, "home"),
          CURSOR_DATA_DIR: runtimeDataRoot,
          PATH: process.env.PATH,
        },
        deferStart: true,
        statePath,
        mcpConnectorSocketPath: join(connectorRoot, "stdio.sock"),
        mcpRuntimeEntryPath: materializeAttestableMcpRuntime(join(root, "attestable-mcp-runtime")),
        mcpRuntimeCwd: root,
        mcpRuntimeEnv,
        providerAuthorization: "Bearer startup-race-provider-proof",
        restrictRemoteAuthority: true,
        allowedWriteSubpaths: [runtimeDataRoot, realpathSync(runtimeDataRoot)],
        allowedReadSubpaths: [root, realpathSync(root)],
        testAgentUpstreamEndpoint: "http://127.0.0.1:9",
        testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
        testStartupBarrier: { path: barrierPath, stage },
      });
      await child.prepared;
      child.release();
      assert.equal(await waitForPath(join(barrierPath, "ready")), true, `${stage} startup barrier was reached`);
      assert.ok(child.pid);
      process.kill(child.pid!, "SIGTERM");
      const exit = await withLoopAlive(child.exited);

      assert.equal(exit.type, "exit");
      assert.equal(existsSync(nativeMarker), false, `${stage} cancellation never launches native Cursor`);
      assert.equal(existsSync(connectorRoot), false, `${stage} cancellation retires the wrapper MCP listener`);
      assert.equal(existsSync(runtimeDataRoot), false, `${stage} cancellation retires the turn-private data root`);
      const terminal = JSON.parse(readFileSync(`${statePath}.terminal.json`, "utf8"));
      assert.equal(terminal.type, "not_started");
      assert.equal(terminal.native_process_group_reaped, true);
      assert.equal(terminal.remote_authority_revoked, true);
    } finally {
      if (child?.pid) {
        try { process.kill(child.pid, "SIGKILL"); } catch {}
      }
      rmSync(connectorRoot, { recursive: true, force: true });
      rmSync(runtimeDataRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("inherited native evidence pipes fail closed on a hard deadline after authority retirement", async () => {
  const root = mkdtempSync("/tmp/letagents-cursor-evidence-deadline-");
  const statePath = join(root, "turn.jsonl");
  const writableRoot = join(root, "writable");
  const escapedPidPath = join(writableRoot, "escaped.pid");
  const executable = join(root, "fake-cursor-agent");
  const connectorRoot = join("/tmp", `letagents-cursor-mcp-${randomUUID()}`);
  const runtimeDataRoot = mkdtempSync("/tmp/letagents-cursor-data-");
  writeFileSync(statePath, "");
  mkdirSync(writableRoot);
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
escaped.unref();
fs.writeFileSync(${JSON.stringify(escapedPidPath)}, String(escaped.pid));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-evidence-deadline" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "must-not-be-accepted-before-close", session_id: "sess-evidence-deadline" }) + "\\n");
`);
  chmodSync(executable, 0o700);
  let escapedPid: number | null = null;
  let child: CursorCliChild | null = null;
  try {
    child = defaultLaunchTurn({
      cursorBin: executable,
      args: ["-p", "--output-format", "stream-json", "evidence deadline"],
      cwd: root,
      env: { HOME: join(root, "home"), CURSOR_DATA_DIR: runtimeDataRoot, PATH: process.env.PATH },
      deferStart: true,
      statePath,
      mcpConnectorSocketPath: join(connectorRoot, "stdio.sock"),
      mcpRuntimeEntryPath: materializeAttestableMcpRuntime(join(root, "attestable-mcp-runtime")),
      mcpRuntimeCwd: root,
      mcpRuntimeEnv: wrapperMcpRuntimeEnv(connectorRoot, "cursor:evidence-deadline"),
      providerAuthorization: "Bearer evidence-deadline-provider-proof",
      restrictRemoteAuthority: true,
      allowedWriteSubpaths: [writableRoot, realpathSync(writableRoot), runtimeDataRoot, realpathSync(runtimeDataRoot)],
      allowedReadSubpaths: [root, realpathSync(root)],
      testAgentUpstreamEndpoint: "http://127.0.0.1:9",
      testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
    });
    await child.prepared;
    const startedAt = Date.now();
    child.release();
    const exit = await withLoopAlive(child.exited);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(existsSync(escapedPidPath), true, `native fixture never launched: ${child.stderrTail()}`);
    escapedPid = Number(readFileSync(escapedPidPath, "utf8"));

    assert.equal(exit.type, "exit");
    if (exit.type === "exit") assert.equal(exit.code, 1);
    assert.ok(elapsedMs >= 2_500 && elapsedMs < 10_000, `evidence drain failed closed in ${elapsedMs}ms`);
    assert.equal(existsSync(`${statePath}.terminal.json`), false, "an open inherited pipe never yields trusted terminal evidence");
    assert.equal(existsSync(connectorRoot), false, "the hard deadline leaves no wrapper MCP authority");
    assert.equal(existsSync(runtimeDataRoot), false, "the hard deadline leaves no turn-private worker root");
    assert.doesNotThrow(() => process.kill(escapedPid!, 0), "the escaped holder demonstrates why close could not complete");
  } finally {
    if (escapedPid && Number.isSafeInteger(escapedPid)) {
      try { process.kill(escapedPid, "SIGKILL"); } catch {}
    }
    if (child?.pid) {
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }
    rmSync(connectorRoot, { recursive: true, force: true });
    rmSync(runtimeDataRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("the live adapter never publishes buffered results when the wrapper evidence deadline fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-evidence-deadline-"));
  const profileRoot = join(root, "private-profile");
  const configDir = join(profileRoot, "config");
  const homeDir = join(profileRoot, "home");
  const tempDir = join(profileRoot, "tmp");
  const escapedPidPath = join(tempDir, "escaped.pid");
  const executable = join(root, "fake-cursor-agent");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
escaped.unref();
fs.writeFileSync(${JSON.stringify(escapedPidPath)}, String(escaped.pid));
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-live-evidence-deadline" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "must-never-be-published", session_id: "sess-live-evidence-deadline" }) + "\\n");
`);
  chmodSync(executable, 0o700);
  let escapedPid: number | null = null;
  let connectorRoot = "";
  let runtimeDataRoot = "";
  let turnId = "";
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalProfileRoot = realpathSync(profileRoot);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          connectorRoot = dirname(input.mcpConnectorSocketPath!);
          runtimeDataRoot = input.env?.CURSOR_DATA_DIR ?? "";
          return defaultLaunchTurn({
            ...input,
            testAgentUpstreamEndpoint: "http://127.0.0.1:9",
            testControlPlaneUpstreamEndpoint: "http://127.0.0.1:9",
          });
        },
      },
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(profileRoot, "data"),
        cacheDir: join(profileRoot, "cache"),
        env: { HOME: homeDir, TMPDIR: tempDir },
        ...wrapperHostedMcpFixture(root),
        nativeAllowedWriteSubpaths: [profileRoot, canonicalProfileRoot],
        nativeAllowedReadSubpaths: [root, canonicalRoot],
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, (terminal) => terminals.push(terminal));
    const startedAt = Date.now();
    await assert.rejects(withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "live-evidence-deadline" }), {
      checkpointTurnStarted: async (value) => { turnId = value; },
    })), /ended before the bounded room turn produced a terminal result/);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(await waitForPath(escapedPidPath), true, "the inherited-pipe fixture launched");
    escapedPid = Number(readFileSync(escapedPidPath, "utf8"));

    assert.ok(elapsedMs >= 2_500 && elapsedMs < 10_000, `live evidence rejection completed in ${elapsedMs}ms`);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.terminalCause, "protocol_error");
    assert.equal(handle.observedState(), "failed");
    assert.ok(turnId);
    const terminalPath = join(configDir, `letagents-cursor-turn-${createHash("sha256").update(turnId).digest("hex")}.jsonl.terminal.json`);
    assert.equal(existsSync(terminalPath), false, "the adapter never invents missing wrapper authority evidence");
    assert.equal(existsSync(connectorRoot), false, "the rejected live result leaves no wrapper MCP authority");
    assert.equal(existsSync(runtimeDataRoot), false, "the rejected live result leaves no turn-private worker root");
  } finally {
    if (escapedPid && Number.isSafeInteger(escapedPid)) {
      try { process.kill(escapedPid, "SIGKILL"); } catch {}
    }
    if (connectorRoot) rmSync(connectorRoot, { recursive: true, force: true });
    if (runtimeDataRoot) rmSync(runtimeDataRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("live results require the same durable remote-authority evidence as restart recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-terminal-proof-"));
  const harness = createHarness({ ownsDescendantReaping: true });
  try {
    const dependencies: CursorProviderAdapterDependencies = {
      ...harness.dependencies,
      prepareTurnState(path) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      },
      launchTurn(input) {
        const child = harness.dependencies.launchTurn(input);
        Object.defineProperty(child, "requiresDurableTerminalEvidence", { value: true });
        return child;
      },
    };
    const adapter = new CursorProviderAdapter({
      dependencies,
      supervisedProfileFactory: (input) => {
        const profileRoot = input.profileRoot ?? root;
        const homeDir = join(profileRoot, "home");
        const configDir = join(profileRoot, "config");
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        return {
          homeDir,
          configDir,
          dataDir: join(profileRoot, "data"),
          cacheDir: join(profileRoot, "cache"),
          env: { HOME: homeDir, NPM_CONFIG_CACHE: join(profileRoot, "npm-cache") },
          ...(input.inspectionOnly ? {} : wrapperHostedMcpFixture(profileRoot)),
        };
      },
    });
    const handle = await spawnDaemonLane(adapter, harness, daemonSpawnRequest({
      cwd: root,
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, (terminal) => terminals.push(terminal));
    const pending = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "live-terminal-proof" }));
    for (let index = 0; index < 100 && harness.children.length === 0; index += 1) await flush();
    const child = harness.children[0]!;
    for (let index = 0; index < 100 && !child.isReleased; index += 1) await flush();
    assert.equal(child.isReleased, true);
    await flush();
    child.emit({
      type: "result", subtype: "success", is_error: false,
      result: "must-not-publish-without-containment", session_id: "sess-cursor-1",
    });
    const statePath = harness.launches[0]!.statePath!;
    writeFileSync(`${statePath}.terminal.json`, JSON.stringify({
      type: "exit",
      code: 0,
      signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: false,
      session_contract_valid: true,
      stream_contract_complete: true,
      init: { type: "system", subtype: "init", session_id: "sess-cursor-1" },
      result: {
        type: "result", subtype: "success", is_error: false,
        result: "must-not-publish-without-containment", session_id: "sess-cursor-1",
      },
    }));
    child.resolveExit({ type: "exit", code: 0, signal: null });

    await assert.rejects(withLoopAlive(pending), /ended before the bounded room turn produced a terminal result/);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.terminalCause, "protocol_error");
    assert.equal(handle.observedState(), "failed");
    assert.deepEqual(
      harness.workspaceGenerationEvents.map((event) => event.kind),
      ["create"],
      "invalid containment evidence leaves the writable generation recoverable and never reconciles it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a writable generation reconciles only after its exact durable containment terminal is valid", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-live-generation-proof-"));
  const harness = createHarness({ ownsDescendantReaping: true });
  try {
    const dependencies: CursorProviderAdapterDependencies = {
      ...harness.dependencies,
      prepareTurnState(path) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      },
      launchTurn(input) {
        const child = harness.dependencies.launchTurn(input);
        Object.defineProperty(child, "requiresDurableTerminalEvidence", { value: true });
        return child;
      },
    };
    const adapter = new CursorProviderAdapter({
      dependencies,
      supervisedProfileFactory: (input) => {
        const profileRoot = input.profileRoot ?? root;
        const homeDir = join(profileRoot, "home");
        const configDir = join(profileRoot, "config");
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        return {
          homeDir,
          configDir,
          dataDir: join(profileRoot, "data"),
          cacheDir: join(profileRoot, "cache"),
          env: { HOME: homeDir, NPM_CONFIG_CACHE: join(profileRoot, "npm-cache") },
          ...(input.inspectionOnly ? {} : wrapperHostedMcpFixture(profileRoot)),
        };
      },
    });
    const handle = await spawnDaemonLane(adapter, harness, daemonSpawnRequest({
      cwd: root,
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    const pending = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "live-generation-proof" }));
    for (let index = 0; index < 100 && harness.children.length === 0; index += 1) await flush();
    const child = harness.children[0]!;
    for (let index = 0; index < 100 && !child.isReleased; index += 1) await flush();
    child.emit({
      type: "result", subtype: "success", is_error: false,
      result: "trusted writable reply", session_id: "sess-cursor-1",
    });
    assert.deepEqual(
      harness.workspaceGenerationEvents.map((event) => event.kind),
      ["create"],
      "live output alone never releases the writable generation",
    );
    const launch = harness.launches[0]!;
    writeFileSync(`${launch.statePath}.terminal.json`, JSON.stringify({
      type: "exit",
      code: 0,
      signal: null,
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: true,
      session_contract_valid: true,
      stream_contract_complete: true,
      workspace_generation_manifest_path: launch.workspaceGenerationManifestPath,
      init: { type: "system", subtype: "init", session_id: "sess-cursor-1" },
      result: {
        type: "result", subtype: "success", is_error: false,
        result: "trusted writable reply", session_id: "sess-cursor-1", request_id: null,
      },
    }));
    child.resolveExit({ type: "exit", code: 0, signal: null });

    assert.equal((await withLoopAlive(pending)).text, "trusted writable reply");
    assert.deepEqual(
      harness.workspaceGenerationEvents.map((event) => event.kind),
      ["create", "retire"],
      "valid exact containment evidence releases reconciliation once",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a finished turn whose wrapper could not prove its remote authority ended settles as lost instead of blocking the lane", async () => {
  const run = await runTurnWithWrapperTerminal("unproven-authority-finished",
    (launch) => unprovenAuthorityTerminal(launch, { remote_authority_failed_checks: ["mcp_runtime_group", "not-a-known-check"] }));

  assert.equal(run.error, undefined, "the turn settles; it does not throw and block the FIFO head");
  assert.deepEqual(run.value, {
    turnId: run.value!.turnId,
    providerContinuationId: "sess-cursor-1",
    outcome: "interrupted",
    text: null,
    evidence: "stream",
    authorityUnproven: true,
    error: "Cursor finished this turn, but LetAgents could not confirm that the turn's helper processes had stopped. "
      + "The turn's reply was not posted and its file changes were not kept.",
  });
  assert.equal(run.value!.outcome === "interrupted" && run.value!.error, cursorAuthorityUnprovenDetail(true));
  const invalid = run.streamEvents.find((event) => event.method === "turn/terminal_invalid");
  assert.match(String((invalid?.payload as { reason?: unknown } | undefined)?.reason),
    /Wrapper checks that failed: mcp_runtime_group\.$/, "the technical observation names the failed clean-up check, and only known names");
  assert.deepEqual(run.checkpointed, [run.value], "the daemon is asked to settle exactly this ending");
  assert.equal(run.terminals.length, 1, "the lane still retires once");
  assert.equal(run.terminals[0]!.terminalCause, "protocol_error");
  assert.equal(run.handle.observedState(), "failed");
  assert.deepEqual(
    run.harness.workspaceGenerationEvents.map((event) => event.kind),
    ["create"],
    "unproven authority never reconciles the writable generation or removes its receipt",
  );
  assert.equal(run.terminalEvidenceKept, true, "the untrusted terminal stays as evidence for a trusted successor");
});

test("a finished read-only turn with unproven remote authority settles as lost the same way", async () => {
  const run = await runTurnWithWrapperTerminal("unproven-authority-read-only", (launch) => unprovenAuthorityTerminal(launch),
    "reply that must not be published", "read_only");

  assert.equal(run.error, undefined);
  assert.equal(run.value?.outcome, "interrupted");
  assert.equal((run.value as { authorityUnproven?: true } | undefined)?.authorityUnproven, true);
  assert.equal((run.value as { error?: string } | undefined)?.error,
    "Cursor finished this turn, but LetAgents could not confirm that the turn's helper processes had stopped. The turn's reply was not posted.",
    "a read-only turn made no file changes, so none are reported lost");
  assert.equal(run.terminals[0]!.terminalCause, "protocol_error");
  assert.deepEqual(run.harness.workspaceGenerationEvents, [], "a read-only turn owns no private generation");
});

for (const [name, terminalFor, liveResult] of [
  ["a wrapper that errored", (launch: { workspaceGenerationManifestPath?: string }) =>
    unprovenAuthorityTerminal(launch, { type: "error", error: "Cursor's live MCP connector ended before the turn became terminal." }), "live"],
  ["a terminal for another workspace generation", (launch: { workspaceGenerationManifestPath?: string }) =>
    unprovenAuthorityTerminal(launch, { workspace_generation_manifest_path: `${launch.workspaceGenerationManifestPath}.other` }), "live"],
  ["a result that differs from the live result", (launch: { workspaceGenerationManifestPath?: string }) =>
    unprovenAuthorityTerminal(launch, {}, "a different final answer"), "live"],
  ["a turn that never produced a result", (launch: { workspaceGenerationManifestPath?: string }) =>
    unprovenAuthorityTerminal(launch, { result: null }), null],
  ["a wrapper that gave no revocation answer at all", (launch: { workspaceGenerationManifestPath?: string }) => {
    const terminal = unprovenAuthorityTerminal(launch);
    delete terminal.remote_authority_revoked;
    return terminal;
  }, "live"],
  ["an incomplete stream contract", (launch: { workspaceGenerationManifestPath?: string }) =>
    unprovenAuthorityTerminal(launch, { stream_contract_complete: false }), "live"],
] as const) {
  test(`unproven authority is trusted only for a sound finished turn, not for ${name}`, async () => {
    const run = await runTurnWithWrapperTerminal(`unproven-authority-${name.replace(/\W+/g, "-")}`, terminalFor, liveResult);

    assert.match(String((run.error as Error | undefined)?.message), /ended before the bounded room turn produced a terminal result/);
    assert.equal(run.value, undefined);
    assert.deepEqual(run.checkpointed, [], "nothing is settled on weaker evidence");
    assert.equal(run.terminals[0]!.terminalCause, "protocol_error");
    assert.deepEqual(run.harness.workspaceGenerationEvents.map((event) => event.kind), ["create"]);
  });
}
