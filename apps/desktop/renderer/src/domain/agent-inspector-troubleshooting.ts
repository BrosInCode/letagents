import type { DesktopSupervisorDaemonStatus } from "../../../electron/ipc-types";
import type { AgentInspectorActionAvailability, AgentInspectorProjection } from "./agent-inspector";
import { sanitizeAgentInspectorDiagnosticsValue } from "./agent-inspector-diagnostics";
import { agentInspectorRuntimeControlMatchesFence, describeAgentInspectorRuntimeControl, type AgentInspectorWorkResource } from "./agent-inspector-work";

export type DiagnosticCheckId = "service" | "provider" | "room" | "delivery";
export type DiagnosticCheckState = "passed" | "attention" | "pending" | "unknown" | "paused";
export interface AgentDiagnosticCheck {
  id: DiagnosticCheckId;
  label: string;
  state: DiagnosticCheckState;
  summary: string;
  detail: string;
  nextStep: string;
  observedAt: string | null;
  action: AgentInspectorActionAvailability | null;
  actionImpact: string | null;
  destination: "overview" | "work" | null;
}
export interface AgentTroubleshooting {
  checks: AgentDiagnosticCheck[];
  headline: string;
  detail: string;
  state: DiagnosticCheckState;
  primaryCheckId: DiagnosticCheckId;
  passedCount: number;
  nextAttemptAt: string | null;
}

export function safeDiagnosticText(value: string | null | undefined): string {
  return value ? String(sanitizeAgentInspectorDiagnosticsValue(value).value) : "";
}

const actionImpacts: Partial<Record<AgentInspectorActionAvailability["kind"], string>> = {
  resume: "Resume this agent so it can receive room work again.",
  reconnect: "Restore this agent’s room connection while keeping its identity and workspace.",
  recover: "Ask LetAgents to recover the saved agent runtime, keeping its identity and workspace.",
  retry_delivery: "Retry the blocked message through its saved delivery record.",
  restore_conversation: "Create a replacement private conversation and retry the message that could not start. The missing conversation’s private context cannot be recovered.",
};

/** Read-only explanations over existing authority. Never infer failure from silence. */
export function projectAgentTroubleshooting(
  projection: AgentInspectorProjection,
  resource: AgentInspectorWorkResource,
  daemon: DesktopSupervisorDaemonStatus | null = null,
): AgentTroubleshooting {
  const { entry } = projection;
  const room = entry.roomAgentState;
  const fresh = projection.resourceFreshness === "fresh";
  const paused = projection.overallState === "paused";
  const stopped = projection.overallState === "retired";
  const held = paused || stopped;
  const detail = resource.detail?.entry_id === entry.id && resource.detail.room_id === entry.roomId ? resource.detail : null;
  const control = fresh && resource.status !== "error" && agentInspectorRuntimeControlMatchesFence(
    detail?.runtime_control, entry.executionGenerationId, daemon?.generation ?? null, entry.runtimeGenerationId,
  ) ? describeAgentInspectorRuntimeControl(detail?.runtime_control) : null;
  const action = (...kinds: AgentInspectorActionAvailability["kind"][]) => fresh
    ? kinds.map(kind => projection.actions.find(candidate => candidate.kind === kind && candidate.available && !candidate.danger
      && (kind !== "recover" || daemon?.capabilities.agentRuntimeRecovery === true)))
      .find(candidate => candidate !== undefined) ?? null
    : null;
  const check = (id: DiagnosticCheckId, label: string, state: DiagnosticCheckState, summary: string, explanation: string,
    nextStep: string, observedAt: string | null = null, recovery: AgentInspectorActionAvailability | null = null,
    destination: AgentDiagnosticCheck["destination"] = null): AgentDiagnosticCheck => ({
    id, label, state, summary, detail: safeDiagnosticText(explanation), nextStep, observedAt, action: recovery,
    actionImpact: recovery ? actionImpacts[recovery.kind] ?? null : null, destination,
  });

  const service = check("service", "Background service", daemon?.healthy && fresh ? "passed" : "unknown",
    daemon?.healthy && fresh ? "Connected to this desktop" : "Connection not confirmed",
    daemon?.healthy && fresh
      ? "The desktop can reach the background service that supervises this agent. Provider and room checks below describe the rest of the path."
      : "The desktop cannot confirm the background service’s current state. Your agent may still be running; these observations do not prove it stopped.",
    "Refresh checks to reconnect and read the latest available state. If the service stays unavailable, reopen the desktop app and copy the diagnostic report for support.");

  let provider = check("provider", "Agent runtime", "unknown", "Current check unavailable",
    "No current provider control check is available. A process ID or a quiet activity feed does not establish whether the agent is reachable.",
    "Refresh checks. If live checks remain unavailable, use the Live and Work tabs to inspect the evidence that this provider does expose.", null, null, "work");
  if (held) provider = check("provider", "Agent runtime", "paused", paused ? "Paused by request" : "Agent stopped",
    paused ? "This agent is intentionally paused. Room work is held until it resumes." : "This saved agent has been stopped. Its retained work is still available.",
    paused ? "Resume the agent when you want it to receive work again." : "Open Work to inspect its saved history.", null, paused ? action("resume") : null, "work");
  else if (["quarantined", "security_blocked", "budget_blocked", "coordination_blocked"].includes(entry.condition)) {
    const reasons = {
      quarantined: ["Repeated runtime failures", "Automatic recovery was stopped after repeated provider exits. Resolve the reported cause before recovering the agent."],
      security_blocked: ["Permission needs attention", "A security or permission requirement is blocking this agent. Review the reported cause before trying again."],
      budget_blocked: ["Usage limit needs attention", "A budget or usage requirement is blocking this agent. Review the reported limit before trying again."],
      coordination_blocked: ["Recovery is waiting for ownership", "LetAgents cannot yet establish the authority needed to continue this agent safely."],
    } as const;
    const [summary, explanation] = reasons[entry.condition as keyof typeof reasons];
    provider = check("provider", "Agent runtime", "attention", summary, explanation,
      "Review the latest error in Technical details. Resolve that cause, then use the available recovery action or refresh checks.", null, action("recover"));
  } else if (control) {
    const state = control.state === "responsive" ? "passed" : ["lost", "exited"].includes(control.state) ? "attention"
      : ["connecting", "stopping"].includes(control.state) ? "pending" : "unknown";
    provider = check("provider", "Agent runtime", state, control.label, control.detail,
      state === "attention" ? "Recover the agent if the action is available, then check its new runtime."
        : state === "pending" ? "Let the current runtime transition finish, then refresh checks."
        : state === "passed" ? "The control connection responded. Use Work to inspect whether a particular message finished."
        : "Refresh checks or inspect Work. An inconclusive check alone does not justify restarting the agent.",
      control.observedAt, state === "attention" ? action("recover") : null, "work");
  } else if (entry.observedState === "failed" || entry.nativeLiveness.state === "terminal") {
    provider = check("provider", "Agent runtime", "attention", "Provider runtime stopped",
      "The saved agent state records a stopped or failed runtime. Unfinished work is not assumed to have completed.",
      "Review the latest error, recover the agent when available, then verify its connection.", entry.nativeLiveness.observedAt, action("recover"));
  } else if (entry.observedState === "starting" || entry.observedState === "recovering") {
    provider = check("provider", "Agent runtime", "pending", "Runtime is being prepared",
      projection.overallDetail || "LetAgents is starting or recovering this agent. A current provider check is still needed.",
      "Refresh checks after the runtime transition. See Technical details for the latest retained error.");
  }

  let connection = check("room", "Room connection", "unknown", "Room status unavailable",
    "No current room connection and message intake evidence is available.", "Refresh checks to read the room connection again.");
  if (room) {
    const waitingCredentials = room.inbox.state === "waiting_for_desktop_credentials";
    const authBlocked = entry.condition === "auth_blocked";
    const restoring = projection.overallState === "recovering" && waitingCredentials;
    const observing = room.connection.state === "connected" && room.ingress.state === "observing" && entry.agentSessionBindingState === "active";
    const reconnecting = room.connection.state === "reconnecting" || ["starting", "backoff"].includes(room.ingress.state);
    connection = check("room", "Room connection", held ? "paused" : authBlocked || waitingCredentials ? restoring ? "pending" : "attention"
      : observing ? "passed" : reconnecting ? "pending" : "attention",
    held ? "Room work is on hold" : authBlocked && !waitingCredentials ? "Authentication needs attention" : waitingCredentials ? restoring ? "Restoring room access" : "Room access needs attention"
      : observing ? "Connected and listening" : reconnecting ? "Reconnecting to the room" : "Message intake is interrupted",
    held ? "The agent is not expected to receive new work while paused or stopped."
      : authBlocked && !waitingCredentials ? "The agent has an authentication blocker. Review the retained error to identify whether provider sign-in or room access needs attention."
      : waitingCredentials ? restoring ? "LetAgents is restoring this agent’s room access automatically."
        : "The agent is waiting for valid room access from the desktop app."
      : observing ? "This agent is connected to its room and the message intake is observing new messages."
      : safeDiagnosticText(room.ingress.detail || room.connection.detail) || "The room connection or message intake is not ready to receive work.",
    held ? "Resume the agent to continue room work." : restoring || reconnecting
      ? "Let the current reconnect attempt finish, then refresh checks. A retry time is shown only when the daemon provides one."
      : authBlocked && !waitingCredentials ? "Review the latest error in Technical details and restore the affected sign-in, then refresh checks."
      : waitingCredentials ? "Confirm the desktop is signed in to the account with room access, then reconnect if available."
      : observing ? "The room path is ready. Check Message delivery if a particular reply is missing."
      : "Reconnect if available, then verify that the room is connected and listening.",
    room.ingress.observedAt || room.connection.observedAt, held || restoring || (authBlocked && !waitingCredentials) ? null : action("reconnect"));
  } else if (entry.condition === "auth_blocked") {
    connection = check("room", "Room connection", "attention", "Authentication needs attention",
      "The agent has an authentication blocker. The retained error can identify whether provider sign-in or room access needs attention.",
      "Review the latest error in Technical details and restore the affected sign-in, then refresh checks.");
  }

  let delivery = check("delivery", "Message delivery", "unknown", "Delivery status unavailable",
    "No current inbox state is available for this agent.", "Refresh checks, or open Work to inspect retained message receipts.", null, null, "work");
  if (room) {
    const blocked = room.inbox.state === "blocked" || room.turn.state === "failed";
    const repairing = room.inbox.state === "restoring_conversation";
    const missing = entry.deliveryReceipts?.some(receipt => receipt.failureCode === "provider_continuation_missing" && ["blocked", "restoring_conversation"].includes(receipt.state));
    const uncertain = projection.turnControl?.status === "uncertain" || Boolean(detail?.uncertain_effects.length);
    const active = ["dispatching", "responding", "publishing", "retrying"].includes(room.turn.state);
    const queued = room.inbox.pendingCount > 0;
    delivery = check("delivery", "Message delivery", held ? "paused" : uncertain || blocked ? "attention" : repairing || active || queued ? "pending" : "passed",
      held ? "Waiting for the agent to resume" : uncertain ? "An outcome needs verification" : repairing ? "Restoring the conversation"
      : blocked ? missing ? "Saved conversation is missing" : "A message needs attention"
      : room.turn.state === "publishing" ? "Publishing the reply" : room.turn.state === "retrying" ? "Retrying message delivery"
      : active ? "The agent is working" : queued ? `${room.inbox.pendingCount} ${room.inbox.pendingCount === 1 ? "message" : "messages"} waiting` : "No messages waiting",
      held ? "New room work is held. Retained receipts remain available in Work."
      : uncertain ? "An operation may have taken effect before its outcome was saved. Verify the recorded work before repeating it."
      : repairing ? "LetAgents is creating a replacement private conversation for the message that could not start."
      : blocked && missing ? "The saved private conversation is unavailable. The blocked message could not start; later messages may be waiting behind it."
      : safeDiagnosticText(room.inbox.detail || room.turn.detail) || (active ? "The message is moving through the provider and reply pipeline. Activity alone does not prove it finished."
        : queued ? "Messages are waiting in this agent’s inbox." : "The current inbox has no pending messages. This does not mean every earlier request succeeded."),
      uncertain ? "Open the recorded work and verify the affected operation before retrying."
      : blocked ? missing ? "Restore the conversation when available, then verify that the blocked message progresses."
        : "Inspect the blocked message in Work. Retry delivery when the exact message is eligible."
      : repairing || active || queued ? "Open Work for the message timeline, or refresh checks for the latest delivery state."
      : "If a reply is missing, open Work to see whether the message was received, completed, or published.",
      null, held || uncertain || repairing ? null : blocked ? action(missing ? "restore_conversation" : "retry_delivery") : null,
      projection.turnControl?.status === "uncertain" ? "overview" : "work");
  }
  // A disconnected observer must never paint cached per-agent facts as healthy.
  const checks = [service, provider, connection, delivery].map(row => !fresh && row.id !== "service"
    ? { ...row, state: "unknown" as const, summary: "Waiting for fresh state", detail: "The desktop is showing a previous observation. Reconnect to the background service before relying on this check.", action: null, actionImpact: null }
    : row);
  const firstIssue = checks.find(row => row.state === "attention") ?? checks.find(row => row.state === "unknown")
    ?? checks.find(row => row.state === "pending") ?? checks.find(row => row.state === "paused") ?? checks[0]!;
  const state = !fresh ? "unknown" : firstIssue.state;
  const passedCount = checks.filter(row => row.state === "passed").length;
  const currentSource = room?.turn.sourceMessageId || room?.inbox.blockedByMessageId;
  const nextAttemptMs = fresh && !held && resource.status === "ready" && currentSource
    && ["pending", "retryable", "result_recovery", "publishing"].includes(detail?.receipt?.state ?? "")
    && (detail?.source_message?.id ?? detail?.requested_source_message_id) === currentSource
    ? detail?.receipt?.next_attempt_at_ms : null;
  return {
    checks, state, primaryCheckId: !fresh ? "service" : firstIssue.id, passedCount,
    headline: !fresh ? "Let’s reconnect to your agent" : held ? paused ? "Your agent is paused" : "Your agent is stopped"
      : state === "passed" ? "Your agent’s connections look good" : state === "attention" ? firstIssue.summary
      : state === "pending" ? firstIssue.summary : "A few checks need a closer look",
    detail: !fresh ? "Fresh observations are unavailable. Start with the background service."
      : state === "passed" ? "The current checks are clear. Trace a message below if a reply is missing."
      : firstIssue.detail,
    nextAttemptAt: typeof nextAttemptMs === "number" && Number.isFinite(nextAttemptMs) && nextAttemptMs > 0 && nextAttemptMs <= 8.64e15
      ? new Date(nextAttemptMs).toISOString() : null,
  };
}
