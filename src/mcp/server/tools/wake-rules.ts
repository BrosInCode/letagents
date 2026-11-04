import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  WAKE_RULE_EVENTS,
  WAKE_RULE_LIMITS,
  WakeRuleError,
  type WakeRule,
  type WakeRulePage,
} from "../../../../shared/wake-rules.mjs";
import { isLocalRoomStorageEnabled, roomScopedApiCall } from "../runtime.js";
import { resolveTaskToolIdentity, resolveTaskToolTarget, taskActorPayload } from "./tasks/context.js";
import { jsonToolResponse, taskToolError } from "./tasks/response.js";
import { roomAccessToolResponse } from "../runtime/room-access.js";

const scope = {
  room_id: z.string().optional().describe("Exact room ID. Defaults to this worker’s room."),
  agent_session_id: z.string().optional(),
};

const LOCAL_ROOM_NOTE = "Wake rules need a room shared online; this room is stored on this device.";

async function roomTarget(roomId: string | undefined) {
  const target = resolveTaskToolTarget(roomId);
  if (!target) throw new WakeRuleError("Join a room first.");
  const id = target.effectiveRoomId || target.roomId || target.projectId!;
  return { target, id, local: await isLocalRoomStorageEnabled(id) };
}

function roomPath(suffix: string) {
  return (id: string) => `/rooms/${encodeURIComponent(id)}/wake-rules${suffix}`;
}

function toolError(error: unknown) {
  return roomAccessToolResponse(error) ?? taskToolError(error instanceof Error ? error.message : String(error));
}

export function registerWakeRuleTools(server: McpServer): void {
  server.tool(
    "add_wake_rule",
    "Wait for something without polling. Say what you are waiting for, then end your turn: you are woken with a room message addressed to you when it happens, or when the rule expires. "
      + "Use this instead of saying you will check back later. Events and arguments: "
      + "timer {at: ISO time} or {after_ms}; "
      + "task.status_changed {task_id, to?: [statuses]}; "
      + "github.check_completed {branch | pr | mine: true, conclusions?: [...]} (one wake per push, after CI goes quiet); "
      + "github.review_submitted {pr | mine: true, states?: [approved, changes_requested, commented]}; "
      + "github.pr_closed {pr | mine: true, merged_only?}; "
      + "room.message {mentions_me: true (default) | any: true, include_agents?} with exactly one of webhook {url, secret} or email {to}: for a hosted bot that cannot poll, LetAgents sends a signed HTTPS POST to url (public https, port 443) or an email to to (after that address confirms) when a room message is for you (with any: every top-level message but yours, and other agents' only with include_agents); it lasts 30 days (adding it again renews it), sends at most one delivery per 10 s and 20 an hour, stops when the sign-in that added it is revoked, and pauses after 5 failed deliveries in a row (add it again to resume). "
      + "`mine` means the branches and pull requests of tasks you are working on. Other rules expire after 24 hours unless you set expires_at (at most 7 days). "
      + "A rule on one pull request ends when it merges (or stays closed for 10 minutes), and a task rule ends when the task is done or cancelled; you are woken once to say your wait ended. "
      + "Adding the same rule twice returns the existing one. People see what you are waiting for and can cancel it.",
    {
      event: z.enum(WAKE_RULE_EVENTS as [string, ...string[]]),
      arguments: z.record(z.string(), z.unknown()).optional().describe("What exactly to wait for; see the event list above."),
      note: z.string().max(280).optional().describe("Why you are waiting, shown to people and repeated to you when you wake, e.g. \"merge #1440 once CI passes\"."),
      repeat: z.boolean().optional().describe("Keep watching after the first wake (at most one wake a minute) until it expires. Not for timers."),
      expires_at: z.string().optional().describe("ISO time to stop waiting. You are woken once more if nothing happened by then."),
      webhook: z.object({
        url: z.string().max(2048).describe("Public https URL of your inbound trigger. Private and loopback addresses are refused."),
        secret: z.string().min(WAKE_RULE_LIMITS.webhookSecretMinLength).max(WAKE_RULE_LIMITS.webhookSecretMaxLength).describe("Shared secret: each POST carries X-LetAgents-Signature, sha256=HMAC-SHA256 of \"<X-LetAgents-Timestamp>.<raw body>\". Stored sealed, never shown."),
        bearer: z.string().min(WAKE_RULE_LIMITS.webhookBearerMinLength).max(WAKE_RULE_LIMITS.webhookBearerMaxLength).optional().describe("Only if the receiver requires a sender key: sent as \"Authorization: Bearer <bearer>\" with each delivery. Stored sealed, never shown."),
      }).optional().describe("room.message only: where to deliver. The URL, secret and bearer are never returned."),
      email: z.object({
        to: z.string().max(254).describe("One email address. It gets a confirmation link first; nothing else is sent until it is opened."),
      }).optional().describe("room.message only, instead of webhook: deliver by email. The address is never returned."),
      ...scope,
    },
    async (input) => {
      try {
        const { target, local } = await roomTarget(input.room_id);
        if (local) return taskToolError(LOCAL_ROOM_NOTE);
        // The server validates the rule and times it by its own clock, so a
        // timer given as after_ms is not skewed by this machine's clock.
        const rule = {
          event: input.event, arguments: input.arguments ?? {}, note: input.note, repeat: input.repeat, expires_at: input.expires_at,
          ...(input.webhook ? { webhook: input.webhook } : {}),
          ...(input.email ? { email: input.email } : {}),
        };
        const { identity, agentSession } = await resolveTaskToolIdentity(target, input.agent_session_id);
        return jsonToolResponse(await roomScopedApiCall<{ rule: WakeRule; created: boolean }>({
          room_id: target.roomId,
          project_id: target.projectId,
          room_path: roomPath(""),
          project_path: roomPath(""),
          options: { method: "POST", body: JSON.stringify({ rule, ...taskActorPayload(identity, agentSession) }) },
        }));
      } catch (error) { return toolError(error); }
    },
  );

  server.tool(
    "list_wake_rules",
    "List what agents in this room are waiting for, and wake rules that recently fired, expired, were cancelled or ended (ended_reason says why). Check this on resume to see what you were waiting for. A webhook, email or MCP Events rule (delivery.kind webhook, email or mcp_event; the last is a ChatGPT subscription made with events/subscribe) shows delivery.kind and delivery.paused to everyone (status pending_confirmation while an email address has not confirmed), and its delivery counts only to the account that owns it; never its URL, secret or address.",
    { ...scope, agent_key: z.string().optional().describe("Only this agent’s rules.") },
    async ({ room_id, agent_key }) => {
      try {
        const { target, local } = await roomTarget(room_id);
        if (local) return jsonToolResponse({ note: LOCAL_ROOM_NOTE, active: [], recent: [] });
        const query = agent_key ? `?agent_key=${encodeURIComponent(agent_key)}` : "";
        return jsonToolResponse(await roomScopedApiCall<WakeRulePage>({
          room_id: target.roomId,
          project_id: target.projectId,
          room_path: roomPath(query),
          project_path: roomPath(query),
        }));
      } catch (error) { return toolError(error); }
    },
  );

  server.tool(
    "cancel_wake_rule",
    "Stop waiting: cancel one of your wake rules when you no longer need it, for example after you checked the result yourself. A webhook or email rule can be cancelled only by its agent or the account that owns it.",
    { rule_id: z.string().regex(/^wake_[a-z0-9]{1,40}$/), ...scope },
    async ({ rule_id, room_id, agent_session_id }) => {
      try {
        const { target, local } = await roomTarget(room_id);
        if (local) return taskToolError(LOCAL_ROOM_NOTE);
        const { identity, agentSession } = await resolveTaskToolIdentity(target, agent_session_id);
        return jsonToolResponse(await roomScopedApiCall<{ rule: WakeRule }>({
          room_id: target.roomId,
          project_id: target.projectId,
          room_path: roomPath(`/${rule_id}/cancel`),
          project_path: roomPath(`/${rule_id}/cancel`),
          options: { method: "POST", body: JSON.stringify(taskActorPayload(identity, agentSession)) },
        }));
      } catch (error) { return toolError(error); }
    },
  );
}
