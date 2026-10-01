import type { DesktopHostApproval, HostApprovalPresentation, HostApprovalStatus } from "../../../../../../shared/host-approvals";

type Field = { label: string; value: string };
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object"
  && !Array.isArray(value) ? value as Record<string, unknown> : null;

// Keep controls and bidi overrides visible; provider-authored text never becomes markup.
function text(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function label(key: string): string {
  const value = key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return text(value.charAt(0).toUpperCase() + value.slice(1));
}

function valueText(value: unknown, depth = 0): string {
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.length ? value.map((item, index) => `${index + 1}. ${valueText(item, depth + 1)}`).join("\n") : "None";
  const object = record(value);
  if (object) return Object.entries(object).map(([key, item]) => `${"  ".repeat(depth)}${label(key)}: ${valueText(item, depth + 1)}`).join("\n") || "None";
  return String(value);
}

function payloadOf(presentation: HostApprovalPresentation): Record<string, unknown> | null {
  try { return record(JSON.parse(presentation.details)); }
  catch { return null; }
}

function mcpAction(params: Record<string, unknown>): { tool: string | null; input: Record<string, unknown> } | null {
  const metadata = record(params._meta);
  const input = record(metadata?.tool_params);
  if (params.mode !== "form" || metadata?.codex_approval_kind !== "mcp_tool_call" || !input) return null;
  // The native elicitation message supplies the tool name; it is a display
  // label only. Dispatch still uses the unchanged signed native request.
  const match = typeof params.message === "string"
    ? /^Allow the .+ MCP server to run tool "([^"\r\n]{1,256})"\?$/.exec(params.message)
    : null;
  return { tool: match?.[1] ?? null, input };
}

export function hostApprovalTitle(presentation: HostApprovalPresentation): string {
  if (presentation.title !== "Run a tool") return presentation.title;
  const payload = payloadOf(presentation);
  const request = record(payload?.request) ?? payload;
  if (presentation.provider === "claude-code" && request) {
    const input = record(request.input);
    if (["Read", "Write", "Edit"].includes(String(request.tool_name)) && typeof input?.file_path === "string") {
      return `${request.tool_name} ${text(input.file_path.split("/").at(-1) || input.file_path)}`;
    }
    if (request.tool_name === "Bash") return "Run a command";
    if (typeof request.tool_name === "string") return `Run ${text(request.tool_name)}`;
  }
  if (presentation.provider === "codex") {
    const params = record(request?.params);
    const action = params && mcpAction(params);
    if (action?.tool) return label(action.tool);
  }
  return presentation.title;
}

export function hostApprovalStatusLabel(status: HostApprovalStatus): string {
  return { pending: "Needs your approval", decision_recorded: "Decision recorded", decision_sent: "Decision sent",
    uncertain: "Approval unconfirmed", request_closed: "Approval request closed", resolved: "Decision applied", unavailable: "Approval unavailable" }[status];
}

/** "Agent · what it asks", or its status once no longer pending. */
export function hostApprovalHeading(approval: Pick<DesktopHostApproval, "presentation" | "status">): string {
  return `${approval.presentation.displayName} · ${approval.status === "pending"
    ? hostApprovalTitle(approval.presentation) : hostApprovalStatusLabel(approval.status)}`;
}

/** A failed match is usually a race (a lane change, a turn not yet checkpointed) that a later listing resolves. */
export const HOST_APPROVAL_BLOCKED_GRACE_MS = 30_000;

/**
 * An Open Model permission still waiting in OpenCode that cannot be decided
 * here, because no durable request backs it, and that has stayed so past the
 * grace. Its agent's turn waits on it until the turn is stopped, which
 * cancels the request.
 */
export function hostApprovalBlocksTurn(approval: Pick<DesktopHostApproval, "presentation" | "status" | "dismissKey">,
  firstSeenAt: string | undefined, nowMs: number): boolean {
  return approval.status === "unavailable" && approval.dismissKey === null
    && approval.presentation.provider === "open-model"
    && typeof payloadOf(approval.presentation)?.permission === "string"
    && nowMs - Date.parse(firstSeenAt ?? "") >= HOST_APPROVAL_BLOCKED_GRACE_MS;
}

/**
 * Stopping an agent's current turn cancels this request only while the
 * request waits in the OpenCode session that the agent is running now.
 */
export function hostApprovalStopsTurn(approval: Pick<DesktopHostApproval, "presentation" | "status" | "dismissKey">,
  firstSeenAt: string | undefined, nowMs: number, providerContinuationId: string | null | undefined): boolean {
  return hostApprovalBlocksTurn(approval, firstSeenAt, nowMs) && Boolean(providerContinuationId)
    && payloadOf(approval.presentation)?.sessionID === providerContinuationId;
}

export function hostApprovalAllowLabel(presentation: HostApprovalPresentation): string {
  return presentation.title === "Grant for this turn" ? "Grant for this turn" : "Allow once";
}

export function hostApprovalAlwaysAllowLabel(presentation: HostApprovalPresentation): string | null {
  const scope = presentation.alwaysAllow;
  if (!scope) return null;
  return `Always allow ${scope.toolLabel} in ${"kind" in scope ? "this room workspace" : scope.projectName}`;
}

export const HOST_APPROVAL_ALWAYS_ALLOW_HINT = "Saved for this agent. Revoke in Permissions. Configured access settings are unchanged.";

/**
 * After a decision, the next request takes the decided one's place, under the
 * pointer. Its decisions stay off this long, so a second click on the old
 * request never answers a new one unread.
 */
export const HOST_APPROVAL_SETTLE_MS = 400;

/** One line: what the request would do, for a list row or the composer tray. */
export function hostApprovalSummary(presentation: HostApprovalPresentation): string {
  return hostApprovalFields(presentation).map(field => `${field.label}: ${field.value}`).join(" · ").replace(/\s+/g, " ").trim();
}

/** Display the proposed action, leaving the signed native presentation untouched. */
export function hostApprovalFields(presentation: HostApprovalPresentation): Field[] {
  let parsed: unknown;
  try { parsed = JSON.parse(presentation.details); }
  catch { return [{ label: "Request", value: text(presentation.details) }]; }
  const payload = record(parsed);
  if (!payload) return [{ label: "Request", value: valueText(parsed) }];
  const fields = (input: Record<string, unknown>): Field[] => Object.entries(input)
    .map(([key, value]) => ({ label: label(key), value: valueText(value) }));
  if (presentation.provider === "claude-code") {
    const request = record(payload.request);
    const input = record(request?.input);
    if (request && input) return [{ label: "Tool", value: valueText(request.tool_name) }, ...fields(input),
      ...fields(Object.fromEntries(Object.entries(request).filter(([key, value]) =>
        !["subtype", "tool_use_id", "tool_name", "input", "permission_suggestions", "decision_reason_type"].includes(key)
        && !(key === "display_name" && value === request.tool_name)
        && !(key === "description" && value === input.description)))),
    ];
  }
  if (presentation.provider === "codex") {
    const request = record(payload.request) ?? payload;
    const params = record(request.params);
    const action = params && mcpAction(params);
    if (params && action) return [
      { label: "Service", value: valueText(params.serverName) },
      ...(action.tool ? [{ label: "Tool", value: text(action.tool) }]
        : [{ label: "Request", value: valueText(params.message) }]),
      ...fields(action.input),
    ];
    if (params) return [
      ...fields(Object.fromEntries(Object.entries(params).filter(([key, value]) => {
        if (["threadId", "turnId", "itemId"].includes(key)) return false;
        if (request.method !== "item/commandExecution/requestApproval") return true;
        if (["startedAtMs", "availableDecisions", "proposedExecpolicyAmendment"].includes(key)) return false;
        if (key === "kind" && value === "command") return false;
        if (key === "environmentId" && value === "local") return false;
        // The full command is the proposal; its parsed duplicate adds no action to review.
        if (key === "commandActions" && typeof params.command === "string" && params.command.trim()) return false;
        return true;
      }))),
      ...(Array.isArray(payload.changes) ? [{ label: "Changes", value: valueText(payload.changes) }] : []),
    ];
  }
  if (presentation.provider === "open-model" && typeof payload.permission === "string") return [
    { label: "Permission", value: text(payload.permission) },
    ...(Array.isArray(payload.patterns) ? [{ label: "Applies to", value: valueText(payload.patterns) }] : []),
    ...fields(record(payload.metadata) ?? {}),
  ];
  return fields(payload);
}
