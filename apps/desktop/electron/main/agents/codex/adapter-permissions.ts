/** Observing, inspecting and answering Codex permission requests. */
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CodexPermissionFileChange, ProviderPermissionDispatchOptions } from "../../../../shared/provider-permissions.js";
import type { RpcServerRequest } from "../codex-rpc-client.js";
import { sameProviderConnectionIdentity, type ProviderConnectionRef, type ProviderHandle } from "../provider-adapter.js";
import { sameProcessBirthIdentity } from "../provider-evidence.js";
import { CodexAdapterAttach } from "./adapter-attach.js";
import { type CodexPermissionObservation, CodexPermissionReplyError } from "./types.js";
import { CodexProviderHandle } from "./handle.js";
import { exactPermissionItemKey, exactTurnKey, recordValue } from "./notifications.js";
import { permissionFileChanges, permissionParams, permissionProfile } from "./permission-requests.js";

export abstract class CodexAdapterPermissions extends CodexAdapterAttach {
  protected permissionAuthority(
    handle: CodexProviderHandle, continuation: string, connection: ProviderConnectionRef, rpcConnection: string | null,
  ): "current" | "degraded" | "unavailable" {
    if (handle.terminal || handle.stopRequested || handle.protocolError || this.handles.get(handle.workAttemptId) !== handle
      || handle.providerContinuationId !== continuation || !sameProviderConnectionIdentity(handle.providerConnection, connection)
      || !rpcConnection || handle.client.currentConnectionId() !== rpcConnection) return "unavailable";
    if (handle.pid === null || handle.pid !== connection.pid || !connection.processIdentity) return "degraded";
    try {
      const actual = this.deps.getProcessIdentity(handle.pid);
      if (actual === undefined) return "degraded";
      return typeof actual === "string" && sameProcessBirthIdentity(actual, connection.processIdentity) ? "current" : "unavailable";
    } catch { return "degraded"; }
  }

  /** Connection-only observation: disconnect loses pending authority, never reconnects or replays it. */
  async observePermissions(
    rawHandle: ProviderHandle, listener: (event: CodexPermissionObservation) => void, signal: AbortSignal,
  ): Promise<void> {
    const handle = this.requireHandle(rawHandle);
    const continuation = handle.providerContinuationId;
    const connection = { ...handle.providerConnection };
    const rpcConnection = handle.client.currentConnectionId();
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      let disposed = false;
      const finish = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        unsubscribeResolved();
        handle.permissionInvalidationListeners.delete(refresh);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const refresh = () => {
        if (disposed || signal.aborted) return;
        const authority = this.permissionAuthority(handle, continuation, connection, rpcConnection);
        const event: CodexPermissionObservation = authority === "current"
          ? { type: "snapshot", connectionId: rpcConnection!, requests: handle.client.listPendingRequests().filter(request =>
            request.connectionId === rpcConnection && permissionParams(request)?.threadId === continuation) }
          : { type: authority };
        try { listener(event); } catch { /* Observation never controls native work. */ }
        if (authority === "unavailable") finish();
      };
      const unsubscribe = handle.client.onPendingRequestsChanged(refresh);
      const unsubscribeResolved = handle.client.onRequestResolved(request => {
        if (disposed || signal.aborted || request.connectionId !== rpcConnection
          || permissionParams(request)?.threadId !== continuation
          || this.permissionAuthority(handle, continuation, connection, rpcConnection) !== "current") return;
        try { listener({ type: "request_closed", request }); } catch { /* Observation only. */ }
      });
      handle.permissionInvalidationListeners.add(refresh);
      signal.addEventListener("abort", finish, { once: true });
      refresh();
    });
  }

  /** Read the exact live proposed edits; historical thread items are not pending-edit evidence. */
  async inspectPermissionFileChanges(rawHandle: ProviderHandle, request: RpcServerRequest): Promise<readonly CodexPermissionFileChange[] | null> {
    try {
      const handle = this.handles.get(rawHandle.workAttemptId);
      if (!handle || handle !== rawHandle || request.method !== "item/fileChange/requestApproval") return null;
      const params = permissionParams(request);
      const continuation = handle.providerContinuationId;
      const connection = { ...handle.providerConnection };
      const rpcConnection = handle.client.currentConnectionId();
      const current = () => this.permissionAuthority(handle, continuation, connection, rpcConnection) === "current"
        && request.connectionId === rpcConnection && handle.client.listPendingRequests().includes(request)
        && !handle.terminalTurns.has(exactTurnKey(continuation, params!.turnId as string));
      if (!params || params.threadId !== continuation || !current()) return null;
      const response = recordValue(await handle.client.request("thread/turns/list", {
        threadId: continuation, limit: 1, sortDirection: "desc", itemsView: "full",
      }));
      if (!current() || !Array.isArray(response?.data) || response.data.length !== 1) return null;
      const turn = recordValue(response.data[0]);
      if (!turn || turn.id !== params.turnId || turn.status !== "inProgress" || turn.itemsView !== "full" || !Array.isArray(turn.items)) return null;
      const matches = turn.items.filter(item => recordValue(item)?.id === params.itemId);
      if (matches.length === 0) {
        const cached = handle.permissionFileChangeProposals.get(exactPermissionItemKey(
          continuation,
          params.turnId as string,
          params.itemId as string,
        ));
        return cached?.connectionId === rpcConnection ? permissionFileChanges(cached.changes) : null;
      }
      const item = recordValue(matches[0]);
      if (matches.length !== 1 || !item || item.type !== "fileChange" || item.status !== "inProgress") return null;
      return permissionFileChanges(item.changes);
    } catch { return null; }
  }

  async inspectPermissionProfile(rawHandle: ProviderHandle, request: RpcServerRequest): Promise<Record<string, unknown> | null> {
    const handle = this.handles.get(rawHandle.workAttemptId);
    const continuation = handle?.providerContinuationId;
    const connection = handle ? { ...handle.providerConnection } : null;
    const rpcConnection = handle?.client.currentConnectionId() ?? null;
    const params = request?.method === "item/permissions/requestApproval" ? permissionParams(request) : null;
    const profile = params ? permissionProfile(params.permissions) : null;
    if (!handle || handle !== rawHandle || !continuation || !connection || !rpcConnection || !params || !profile
      || params.threadId !== continuation || request.connectionId !== rpcConnection
      || !handle.client.listPendingRequests().includes(request)
      || handle.terminalTurns.has(exactTurnKey(continuation, params.turnId as string))
      || this.permissionAuthority(handle, continuation, connection, rpcConnection) !== "current") return null;
    return structuredClone(profile);
  }

  async inspectPermissionMcpToolCall(rawHandle: ProviderHandle, request: RpcServerRequest): Promise<Record<string, unknown> | null> {
    const handle = this.handles.get(rawHandle.workAttemptId);
    const params = request.method === "mcpServer/elicitation/request" ? permissionParams(request) : null;
    if (!handle || handle !== rawHandle || !params || params.threadId !== handle.providerContinuationId
      || request.connectionId !== handle.client.currentConnectionId() || !handle.client.listPendingRequests().includes(request)
      || handle.terminalTurns.has(exactTurnKey(handle.providerContinuationId, params.turnId as string))
      || this.permissionAuthority(handle, handle.providerContinuationId, { ...handle.providerConnection },
        handle.client.currentConnectionId()) !== "current") return null;
    return structuredClone(params);
  }

  /** Host-only dispatch. A successful WebSocket send is NOT evidence that Codex applied the decision. */
  async replyPermission(rawHandle: ProviderHandle, expectedRequest: RpcServerRequest, reply: "once" | "reject",
    options?: ProviderPermissionDispatchOptions):
    Promise<{ outcome: "sent"; scope: "request" }> {
    const handle = this.handles.get(rawHandle.workAttemptId);
    if (!handle || handle !== rawHandle) throw new CodexPermissionReplyError("not_dispatched");
    const continuation = handle.providerContinuationId;
    const connection = { ...handle.providerConnection };
    const rpcConnection = handle.client.currentConnectionId();
    const params = expectedRequest && permissionParams(expectedRequest);
    const fileChange = expectedRequest?.method === "item/fileChange/requestApproval";
    const genericPermission = expectedRequest?.method === "item/permissions/requestApproval";
    const mcpToolCall = expectedRequest?.method === "mcpServer/elicitation/request";
    const expectedMcpParams = mcpToolCall && params ? structuredClone(params) : null;
    const expectedChanges = fileChange ? permissionFileChanges(options?.expectedFileChanges) : null;
    const requestedPermissions = genericPermission ? structuredClone(permissionProfile(params?.permissions)) : null;
    const decision = reply === "once" ? "accept" : reply === "reject" ? "decline" : null;
    if (!params || params.threadId !== continuation || !decision || (fileChange && !expectedChanges)
      || (genericPermission && !requestedPermissions)
      || (decision === "accept" && expectedRequest.method === "item/fileChange/requestApproval" && params.grantRoot != null)
      || (params.availableDecisions != null && (!Array.isArray(params.availableDecisions) || !params.availableDecisions.includes(decision)))) {
      throw new CodexPermissionReplyError("not_dispatched");
    }
    const assertCurrent = () => {
      if (this.permissionAuthority(handle, continuation, connection, rpcConnection) !== "current"
        || expectedRequest.connectionId !== rpcConnection || !handle.client.listPendingRequests().includes(expectedRequest)
        || handle.terminalTurns.has(exactTurnKey(continuation, params.turnId as string))) {
        throw new CodexPermissionReplyError("not_dispatched");
      }
    };
    assertCurrent();
    if (fileChange) {
      if (!isDeepStrictEqual(await this.inspectPermissionFileChanges(handle, expectedRequest), expectedChanges)) {
        throw new CodexPermissionReplyError("not_dispatched");
      }
    } else {
      // A resumed history may retain an in-progress turn from a dead process.
      // Pending requests belong to this connection's exact latest native turn;
      // historical discovery cannot establish their dispatch authority.
      let response: Record<string, unknown> | null;
      try {
        response = recordValue(await handle.client.request("thread/turns/list", {
          threadId: continuation, limit: 1, sortDirection: "desc", itemsView: "full",
        }));
      } catch { throw new CodexPermissionReplyError("not_dispatched"); }
      const turn = Array.isArray(response?.data) && response.data.length === 1 ? recordValue(response.data[0]) : null;
      if (!turn || turn.id !== params.turnId || turn.status !== "inProgress" || turn.itemsView !== "full") {
        throw new CodexPermissionReplyError("not_dispatched");
      }
    }
    assertCurrent();
    if (options) await options.beforeNativeDispatch();
    if (fileChange && !isDeepStrictEqual(await this.inspectPermissionFileChanges(handle, expectedRequest), expectedChanges)) {
      throw new CodexPermissionReplyError("not_dispatched");
    }
    if (genericPermission && !isDeepStrictEqual(permissionProfile(params.permissions), requestedPermissions)) {
      throw new CodexPermissionReplyError("not_dispatched");
    }
    if (mcpToolCall && !isDeepStrictEqual(permissionParams(expectedRequest), expectedMcpParams)) {
      throw new CodexPermissionReplyError("not_dispatched");
    }
    // No await or observer callback between the final fence and native response.
    assertCurrent();
    options?.assertNativeDispatch?.();
    const result = mcpToolCall
      ? { action: decision, content: reply === "once" ? {} : null, _meta: null }
      : genericPermission
      ? reply === "once"
        ? { permissions: requestedPermissions, scope: "turn", strictAutoReview: true }
        : { permissions: {}, scope: "turn" }
      : { decision };
    try { handle.client.respond(expectedRequest, result); }
    catch { throw new CodexPermissionReplyError("uncertain"); }
    if (this.permissionAuthority(handle, continuation, connection, rpcConnection) !== "current") {
      throw new CodexPermissionReplyError("uncertain");
    }
    return { outcome: "sent", scope: "request" };
  }
}
