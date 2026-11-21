import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  hostApprovalCandidateSchema as approvalCandidate,
  hostApprovalChallengeSchema as approvalChallenge,
  hostApprovalIdSchema as approvalId,
  hostApprovalStatusSchema as approvalStatus,
  hostToolRuleSchema as hostToolRule,
} from "#daemon-contract/index.js";
import type { HostApprovalChallenge } from "../../../shared/host-approval-auth.js";
import type { DesktopHostApproval, DesktopHostApprovalSnapshot, HostApprovalCandidate, HostApprovalSelection, HostApprovalStatus } from "../../../shared/host-approvals.js";
import type { HostApprovalSigner } from "../host-approval-auth.js";
import { mapAgentConfiguration } from "./agent-mapping.js";
import { record } from "./wire-values.js";
import { SupervisorDaemonLifecycleClient } from "./client-lifecycle.js";

export abstract class SupervisorDaemonHostApprovalClient extends SupervisorDaemonLifecycleClient {
  /** Main computes and remembers what it actually presents; renderer IDs carry no authority. */
  async listHostApprovals(roomId: string): Promise<DesktopHostApprovalSnapshot> {
    try {
      if (!approvalId.safeParse(roomId).success) throw new Error("Invalid approval room.");
      // Opening a composer must not spawn, hand off, or reconfigure a provider.
      // Wait only for startup already owned by the app; an absent or failed
      // service still returns unavailable without initiating any recovery.
      await this.waitForStartup();
      const rawChallenge = await this.call("supervisor.host_approval_challenge");
      if (rawChallenge === null) {
        this.clearApprovalPresentations(roomId);
        return { available: false, approvals: [], error: "Host approval signing was not enrolled. Unlock secure storage and restart the background service before approving." };
      }
      const challenge = approvalChallenge.parse(rawChallenge);
      const signer = await this.signerForApproval(challenge);
      const raw = await this.call("supervisor.host_approval_request", signer.sign(challenge, "list", { roomId }));
      if (!Array.isArray(raw) || raw.length > 128) throw new Error("Invalid approval presentation.");
      for (const candidate of raw) {
        const parsed = approvalCandidate.safeParse(candidate);
        if (!parsed.success || Buffer.byteLength(JSON.stringify(candidate)) > 32 * 1024
          || (parsed.data.reference && (parsed.data.reference.roomId !== roomId
            || parsed.data.reference.agentId !== parsed.data.presentation.agentId))
          || (parsed.data.presentation.alwaysAllow && (parsed.data.presentation.alwaysAllow.agentId !== parsed.data.presentation.agentId
            || parsed.data.presentation.alwaysAllow.provider !== parsed.data.presentation.provider))
          || (!parsed.data.reference && parsed.data.status !== "unavailable")
          || (parsed.data.presentation.title === "Approval unavailable" && parsed.data.status !== "unavailable"
            && !(parsed.data.status === "uncertain" && parsed.data.reference && parsed.data.recordedDecision))
          || (parsed.data.presentation.provider === "open-model") !== (parsed.data.presentation.denyScope === "session_pending")) {
          throw new Error("Invalid approval presentation.");
        }
      }
      // Preserve the transmitted property order used by the daemon's digest.
      const candidates = structuredClone(raw) as HostApprovalCandidate[];
      const now = this.now().getTime();
      for (const [key, item] of this.approvalPresentations) {
        if (now - item.touchedAt > 30 * 60 * 1000) this.approvalPresentations.delete(key);
      }
      const approvals: DesktopHostApproval[] = [];
      for (const candidate of candidates) {
        const presentationSha256 = createHash("sha256").update(JSON.stringify(candidate.presentation)).digest("hex");
        let cached = [...this.approvalPresentations.values()].find(item =>
          item.roomId === roomId && JSON.stringify(item.challenge) === JSON.stringify(challenge) && item.presentationSha256 === presentationSha256
          && JSON.stringify(item.candidate.reference) === JSON.stringify(candidate.reference));
        if (!cached) {
          cached = { roomId, view: { id: randomUUID(), presentation: candidate.presentation, status: candidate.status, detail: candidate.detail, retryDecision: null, dismissKey: null,
            requestKey: candidate.reference ? createHash("sha256").update(JSON.stringify(["host-approval-request", roomId, candidate.reference.requestId])).digest("hex") : null },
            candidate, challenge, presentationSha256, touchedAt: now, decision: null };
          this.approvalPresentations.set(cached.view.id, cached);
        }
        // Polling the same authenticated snapshot must not revoke an in-flight
        // decision. Any changed candidate still invalidates its dispatch fence.
        if (!isDeepStrictEqual(cached.candidate, candidate)) cached.candidate = candidate;
        cached.touchedAt = now;
        cached.view.status = candidate.status;
        cached.view.detail = candidate.detail;
        cached.view.retryDecision = null;
        const recorded = candidate.recordedDecision;
        if (recorded) {
          cached.decision = { id: recorded.decisionId, choice: recorded.decision, projectionSha256: recorded.projectionSha256 };
          // The retry is signed against the digest the choice was made on. The card can differ from it by now
          // (a saved mode changes the tool scope inside it) while the request does not; the daemon checks the request.
          if (candidate.status === "decision_recorded" && recorded.actorId === `host-${challenge.keyFingerprint}`
            && recorded.projectionSha256 !== null) cached.view.retryDecision = recorded.decision;
          else if (candidate.status === "pending" || candidate.status === "decision_recorded") {
            cached.view.status = "unavailable";
            cached.view.detail = "The recorded decision cannot be retried against this presentation. No new decision will be created.";
          }
        } else if (candidate.status === "decision_recorded") {
          cached.view.status = "unavailable";
          cached.view.detail = "The recorded decision identity is unavailable. No new decision will be created.";
        }
        // The daemon keeps an undecidable record visible across restarts until it
        // expires on a retired runtime, and the presentation ID is random per
        // session. Give the owner's dismissal a stable identity. Only a durable
        // record carries a reference with this reserved title; a prompt still on
        // a live lane keeps its own title even once expired, and must reappear.
        cached.view.dismissKey = candidate.reference && candidate.presentation.title === "Approval unavailable"
          ? createHash("sha256").update(JSON.stringify(["host-approval-dismissal", roomId,
            candidate.reference.requestId, candidate.reference.requestVersion, cached.view.status])).digest("hex")
          : null;
        approvals.push(structuredClone(cached.view));
      }
      const retained = new Set(approvals.map(item => item.id));
      for (const [key, item] of this.approvalPresentations) if (item.roomId === roomId && !retained.has(key)) this.approvalPresentations.delete(key);
      while (this.approvalPresentations.size > 128) this.approvalPresentations.delete(this.approvalPresentations.keys().next().value!);
      return { available: true, approvals, error: null };
    } catch {
      this.clearApprovalPresentations(roomId);
      return { available: false, approvals: [], error: "Could not load host approvals. Check secure storage and the background service, then refresh." };
    }
  }

  private clearApprovalPresentations(roomId: string): void {
    for (const [key, item] of this.approvalPresentations) if (item.roomId === roomId) this.approvalPresentations.delete(key);
  }

  private signerForApproval(challenge: HostApprovalChallenge): Promise<HostApprovalSigner> {
    if (this.approvalSigner?.fingerprint === challenge.keyFingerprint) return this.approvalSigner.promise;
    const pending = { fingerprint: challenge.keyFingerprint, promise: this.loadApprovalSigner().then(signer => {
      if (createHash("sha256").update(Buffer.from(signer.publicKey, "base64")).digest("hex") !== challenge.keyFingerprint) {
        throw new Error("Host approval signer does not match this daemon.");
      }
      return signer;
    }) };
    this.approvalSigner = pending;
    void pending.promise.catch(() => { if (this.approvalSigner === pending) this.approvalSigner = null; });
    return pending.promise;
  }

  async decideHostApproval(input: { id: string; decision: HostApprovalSelection }, assertCaller?: () => void): Promise<HostApprovalStatus> {
    if (!input || Object.keys(input).length !== 2 || typeof input.id !== "string"
      || !["allow_once", "deny", "allow_always"].includes(input.decision)) throw new Error("Invalid approval decision.");
    const selection = { id: input.id, decision: input.decision };
    assertCaller?.();
    const cached = this.approvalPresentations.get(selection.id);
    if (!cached?.candidate.reference || this.now().getTime() - cached.touchedAt > 30 * 60 * 1000) throw new Error("Refresh the approval before deciding.");
    const assertEligible = () => {
      if (selection.decision === "allow_always" && !cached.view.presentation.alwaysAllow) throw new Error("This request has no reusable tool permission.");
      if (this.approvalPresentations.get(selection.id) !== cached || this.now().getTime() - cached.touchedAt > 30 * 60 * 1000
        || (cached.view.status !== "pending" && !(cached.view.status === "decision_recorded" && cached.view.retryDecision === selection.decision))) {
        throw new Error("Refresh the approval before deciding; this request cannot currently be sent.");
      }
      if (cached.decision && cached.decision.choice !== selection.decision) throw new Error("A different decision is already recorded for this request.");
    };
    assertEligible();
    const presented = cached.candidate;
    const expected = structuredClone(cached.candidate.reference);
    const signer = await this.signerForApproval(cached.challenge);
    const challenge = approvalChallenge.parse(await this.call("supervisor.host_approval_challenge"));
    if (JSON.stringify(challenge) !== JSON.stringify(cached.challenge)) throw new Error("The background service changed. Refresh the approval before deciding.");
    assertCaller?.();
    assertEligible();
    if (cached.candidate !== presented) throw new Error("The approval was refreshed while deciding. Check it before trying again.");
    const decision = cached.decision ?? { id: randomUUID(), choice: selection.decision, projectionSha256: null };
    const envelope = signer.sign(challenge, "decide", { expected,
      decisionId: decision.id, actorId: `host-${challenge.keyFingerprint}`,
      decision: decision.choice, projectionSha256: decision.projectionSha256 ?? cached.presentationSha256 });
    cached.decision = decision;
    cached.view.status = "uncertain";
    cached.view.retryDecision = null;
    try {
      const status = await this.call("supervisor.host_approval_request", envelope, {
        assertDispatch: () => {
          assertCaller?.();
          if (this.approvalPresentations.get(selection.id) !== cached || cached.candidate !== presented
            || this.now().getTime() - cached.touchedAt > 30 * 60 * 1000 || cached.decision !== decision) {
            throw new Error("The approval changed before dispatch.");
          }
        },
      }) as HostApprovalStatus;
      if (!approvalStatus.safeParse(status).success || status === "pending") throw new Error();
      if (cached.candidate === presented && cached.decision === decision) {
        cached.view.status = status;
        cached.view.retryDecision = null;
      }
      return status;
    } catch {
      // Keep the exact decision identity: the daemon may have committed it.
      if (cached.candidate === presented && cached.decision === decision) {
        cached.view.status = "uncertain";
        cached.view.retryDecision = null;
      }
      throw new Error("Could not confirm the decision. Refresh to check it; no new decision has been created.");
    }
  }

  async listHostToolRules(agentId: string): Promise<import("../../../shared/host-tool-rules.js").HostToolRule[]> {
    approvalId.parse(agentId);
    await this.waitForStartup();
    const challenge = approvalChallenge.parse(await this.call("supervisor.host_approval_challenge"));
    const signer = await this.signerForApproval(challenge);
    const raw = await this.call("supervisor.host_approval_request", signer.sign(challenge, "list_tool_rules", { agentId }));
    const rules = z.array(hostToolRule).parse(raw);
    if (rules.some(rule => rule.scope.agentId !== agentId || rule.ownerId !== `host-${challenge.keyFingerprint}`)) throw new Error("Invalid saved permissions.");
    return rules;
  }

  async revokeHostToolRule(input: { agentId: string; ruleId: string; revision: number }, assertCaller?: () => void): Promise<void> {
    const value = z.strictObject({ agentId: approvalId, ruleId: approvalId, revision: z.number().int().positive().safe() }).parse(input);
    assertCaller?.();
    await this.waitForStartup();
    const challenge = approvalChallenge.parse(await this.call("supervisor.host_approval_challenge"));
    const signer = await this.signerForApproval(challenge);
    assertCaller?.();
    await this.call("supervisor.host_approval_request", signer.sign(challenge, "revoke_tool_rule", value), { assertDispatch: assertCaller });
  }

  /**
   * Let one agent use the owner's own provider setup, or stop it. The request
   * is signed with the desktop app's own key, so the daemon accepts it from
   * nothing else that can reach its socket: not an agent, and not an agent's
   * tools.
   */
  async setAgentHomeHarness(
    input: import("../../ipc-types/agents.js").DesktopSupervisorAgentHomeHarnessInput,
    assertCaller?: () => void,
  ): Promise<import("../../ipc-types/agents.js").DesktopSupervisorAgentHomeHarnessResult> {
    const value = z.strictObject({
      entryId: approvalId, daemonGeneration: z.number().int().positive().safe(),
      expectedRevision: z.number().int().positive().safe(), enabled: z.boolean(),
    }).parse(input);
    assertCaller?.();
    await this.waitForStartup();
    const rawChallenge = await this.call("supervisor.host_approval_challenge");
    if (rawChallenge === null) {
      return { outcome: "invalid", error: "This app could not prove the change came from you. Unlock secure storage and restart the background service, then try again." };
    }
    const challenge = approvalChallenge.parse(rawChallenge);
    const signer = await this.signerForApproval(challenge);
    assertCaller?.();
    const result = record(await this.call("supervisor.host_approval_request", signer.sign(challenge, "set_home_harness", value),
      { assertDispatch: assertCaller })) ?? {};
    if (result.outcome === "invalid") {
      if (typeof result.error !== "string" || !result.error.trim()) throw new Error("Supervisor returned an invalid configuration error response.");
      return { outcome: "invalid", error: result.error };
    }
    if (result.outcome !== "updated" && result.outcome !== "conflict") throw new Error("Supervisor returned an invalid configuration update result.");
    // Present only when turning it off met a process that still had the owner's setup.
    const restart = !Object.hasOwn(result, "apply") ? {}
      : { restart: result.apply === "restarting" ? "restarting" as const : result.apply === "busy_active_turn" ? "busy" as const : "not_restarted" as const };
    return { outcome: result.outcome, configuration: mapAgentConfiguration(record(result.configuration) ?? {}, value.entryId, value.daemonGeneration), ...restart };
  }

  /**
   * Stop a command that an agent runs in the background. Signed like the
   * live-sharing choice, so nothing else that reaches the daemon's socket, an
   * agent included, can stop an agent's command.
   */
  async stopBackgroundCommand(
    input: import("../../ipc-types/agents.js").DesktopStopBackgroundCommandInput,
    assertCaller?: () => void,
  ): Promise<import("../../ipc-types/agents.js").DesktopStopBackgroundCommandResult> {
    const value = z.strictObject({
      entryId: approvalId, daemonGeneration: z.number().int().positive().safe(), taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    }).parse(input);
    assertCaller?.();
    await this.waitForStartup();
    const rawChallenge = await this.call("supervisor.host_approval_challenge");
    if (rawChallenge === null) {
      return { outcome: "invalid", error: "This app could not prove the request came from you. Unlock secure storage and restart the background service, then try again." };
    }
    const challenge = approvalChallenge.parse(rawChallenge);
    const signer = await this.signerForApproval(challenge);
    assertCaller?.();
    const result = record(await this.call("supervisor.host_approval_request", signer.sign(challenge, "stop_background_command", value),
      { assertDispatch: assertCaller })) ?? {};
    if (result.outcome === "invalid") return { outcome: "invalid", error: typeof result.error === "string" && result.error.trim() ? result.error : "The command could not be stopped." };
    if (result.outcome === "stopping" || result.outcome === "not_running" || result.outcome === "failed") return { outcome: result.outcome };
    throw new Error("Supervisor returned an invalid stop result.");
  }

  /**
   * Share one agent's live activity with its room, or stop. Signed like the
   * owner's-setup choice, so nothing else that reaches the daemon's socket,
   * an agent included, can share an agent's work with its room.
   */
  async setAgentLiveSharing(
    input: import("../../ipc-types/agents.js").DesktopSupervisorAgentLiveSharingInput,
    assertCaller?: () => void,
  ): Promise<import("../../ipc-types/agents.js").DesktopSupervisorAgentConfigurationUpdateResult> {
    const value = z.strictObject({
      entryId: approvalId, daemonGeneration: z.number().int().positive().safe(), enabled: z.boolean(),
    }).parse(input);
    assertCaller?.();
    await this.waitForStartup();
    const rawChallenge = await this.call("supervisor.host_approval_challenge");
    if (rawChallenge === null) {
      return { outcome: "invalid", error: "This app could not prove the change came from you. Unlock secure storage and restart the background service, then try again." };
    }
    const challenge = approvalChallenge.parse(rawChallenge);
    const signer = await this.signerForApproval(challenge);
    assertCaller?.();
    const result = record(await this.call("supervisor.host_approval_request", signer.sign(challenge, "set_live_sharing", value),
      { assertDispatch: assertCaller })) ?? {};
    if (result.outcome === "invalid") {
      if (typeof result.error !== "string" || !result.error.trim()) throw new Error("Supervisor returned an invalid configuration error response.");
      return { outcome: "invalid", error: result.error };
    }
    if (result.outcome !== "updated") throw new Error("Supervisor returned an invalid configuration update result.");
    return { outcome: "updated", configuration: mapAgentConfiguration(record(result.configuration) ?? {}, value.entryId, value.daemonGeneration) };
  }
}
