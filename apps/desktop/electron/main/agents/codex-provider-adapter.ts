import { readCodexUsageTail } from "./provider-usage.js";
import type { ProviderUsage } from "../../../shared/provider-usage.js";
import { sameProviderConnectionIdentity, type ProviderAdapter, type ProviderAttachTerminal, type ProviderContinuationRef, type ProviderHandle, type ProviderSpawnRequest } from "./provider-adapter.js";
import { CodexAdapterLifecycle } from "./codex/adapter-lifecycle.js";
import { CodexProviderHandle } from "./codex/handle.js";
import { boundedCodexTools, boundedLaunchContract, codexTurnPolicy } from "./codex/launch-contract.js";
export { CODEX_READ_ONLY_CONFIG_OVERRIDES } from "./codex/thread-access.js";
export type { CodexAdapterRpc } from "./codex/types.js";
export type { CodexPermissionObservation } from "./codex/types.js";
export { CodexPermissionReplyError } from "./codex/types.js";
export type { CodexProviderAdapterDependencies } from "./codex/types.js";
export { COMMAND_OUTPUT_WINDOW_MS } from "./codex/types.js";
export type { CodexProviderAdapterOptions } from "./codex/types.js";
export { codexMcpWorkplaceConfigOverrides } from "./codex/launch-contract.js";
export { CODEX_BOUNDED_LAUNCH_CONTRACT_VERSION } from "./codex/launch-contract.js";
export { CODEX_READ_ONLY_ROOM_TOOLS } from "./codex/launch-contract.js";



export class CodexProviderAdapter extends CodexAdapterLifecycle implements ProviderAdapter {
  async readUsage(providerHandle: ProviderHandle): Promise<ProviderUsage | null> {
    const handle = this.requireHandle(providerHandle);
    const continuation = handle.providerContinuationId;
    const connection = handle.client.currentConnectionId();
    if (this.handles.get(handle.workAttemptId) !== handle || !connection) return null;
    handle.usage.snapshot(continuation);
    const current = () => this.handles.get(handle.workAttemptId) === handle
      && handle.providerContinuationId === continuation && handle.client.currentConnectionId() === connection;
    const now = Date.parse(this.deps.now());
    const key = `${connection}:${continuation}`;
    if (handle.usageConnection !== key) {
      handle.usageReadAt = 0; handle.usageRead = null;
      if (handle.usageConnection) handle.usage.accountFailed();
      handle.usageConnection = key;
    }
    if (!handle.usageRead && (!handle.usageReadAt || now - handle.usageReadAt >= 30_000)) {
      handle.usageReadAt = now;
      const accountRevision = handle.usage.accountRevision;
      const reading = (async () => {
        await Promise.all([
          handle.client.request("account/rateLimits/read", undefined, { timeoutMs: 2_000 }).then(payload => {
            if (current()) handle.usage.account(payload, this.deps.now(), accountRevision);
          }, () => { if (current()) handle.usage.accountFailed(accountRevision); }),
          (async () => {
            if (handle.usage.snapshot(continuation).context) return;
            try {
              const read = await handle.client.request<{ thread?: { id?: string; path?: unknown } }>("thread/read", { threadId: continuation, includeTurns: false }, { timeoutMs: 2_000 });
              if (!current() || read.thread?.id !== continuation) return;
              const context = await readCodexUsageTail(read.thread.path);
              if (current()) handle.usage.seedContext(context);
            } catch { /* A not-yet-materialized thread has no previous sample. */ }
          })(),
        ]);
      })().finally(() => { if (handle.usageRead === reading) handle.usageRead = null; });
      handle.usageRead = reading;
    }
    await handle.usageRead;
    return current() ? handle.usage.snapshot(continuation) : null;
  }

  async describeManagedLaunchContract(input: { apiUrl: string; devMcpServerEntryPath?: string }): Promise<string | null> {
    // Mutable development trees have no release seal and require explicit recovery.
    if (input.devMcpServerEntryPath) return null;
    const runtime = this.deps.resolveMcpRuntime();
    const tools = boundedCodexTools(await this.deps.readMcpRuntimeContract(runtime.entryPath, input.apiUrl));
    return boundedLaunchContract(input.apiUrl, tools);
  }

  async preflightCustodialPolling(input: { devMcpServerEntryPath?: string }): Promise<void> {
    await this.resolveCustodialPollingRuntime(input.devMcpServerEntryPath);
  }

  async spawn(req: ProviderSpawnRequest): Promise<ProviderHandle> {
    return this.start(req, null);
  }

  async attach(ref: ProviderContinuationRef): Promise<ProviderHandle | ProviderAttachTerminal | null> {
    ref = { ...ref, ...(ref.launchPolicy === undefined ? {} : { launchPolicy: codexTurnPolicy(ref.launchPolicy) }) };
    const authorityMode = ref.lifecycleAuthorityMode ?? "typed_shadow";
    const handle = this.handles.get(ref.workAttemptId);
    if (
      !handle ||
      handle.terminal ||
      handle.lifecycleAuthorityMode !== authorityMode ||
      handle.providerContinuationId !== ref.providerContinuationId ||
      !sameProviderConnectionIdentity(handle.providerConnection, ref.providerConnection)
    ) {
      if (handle) return null;
    } else {
      return this.bindFoundPolicy(handle, ref.launchPolicy);
    }
    const connection = ref.providerConnection;
    if (!connection || connection.kind !== "codex_app_server") {
      return null;
    }
    const pending = this.pendingAttaches.get(ref.workAttemptId);
    if (pending) {
      if (
        pending.ref.providerContinuationId !== ref.providerContinuationId
        || (pending.ref.lifecycleAuthorityMode ?? "typed_shadow") !== authorityMode
        || !sameProviderConnectionIdentity(pending.ref.providerConnection, connection)
      ) return null;
      const attached = await pending.promise;
      return attached instanceof CodexProviderHandle ? this.bindFoundPolicy(attached, ref.launchPolicy) : attached;
    }
    const attaching = this.attachRunning(ref, connection).finally(() => {
      if (this.pendingAttaches.get(ref.workAttemptId)?.promise === attaching) {
        this.pendingAttaches.delete(ref.workAttemptId);
      }
    });
    this.pendingAttaches.set(ref.workAttemptId, { ref, promise: attaching });
    return attaching;
  }

  async resume(
    ref: ProviderContinuationRef,
    req: ProviderSpawnRequest,
  ): Promise<ProviderHandle> {
    if (ref.workAttemptId !== req.workAttemptId) {
      throw new Error("Codex resume ref must belong to the same work attempt.");
    }
    return this.start(req, ref);
  }

  async poke(_handle: ProviderHandle, _message: string): Promise<void> {
    throw new Error("Codex mid-turn injection is not enabled: P0 proved room delivery, not native poke.");
  }
}
