import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  WAKE_RULE_EVENTS,
  WakeRuleError,
  type WakeRule,
  type WakeRulePage,
} from "../../../../shared/wake-rules.mjs";
import { isLocalRoomStorageEnabled, roomScopedApiCall } from "../runtime.js";
import { resolveTaskToolIdentity, resolveTaskToolTarget, taskActorPayload } from "./tasks/context.js";
import { jsonToolResponse, taskToolError } from "./tasks/response.js";

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
  return taskToolError(error instanceof Error ? error.message : String(error));
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
      + "github.pr_closed {pr | mine: true, merged_only?}. "
      + "`mine` means the branches and pull requests of tasks you are working on. Rules expire after 24 hours unless you set expires_at (at most 7 days). "
      + "A rule on one pull request ends when it merges or closes, and a task rule ends when the task is done or cancelled; you are woken for that only if it is what you wait for. "
      + "Adding the same rule twice returns the existing one. People see what you are waiting for and can cancel it.",
    {
      event: z.enum(WAKE_RULE_EVENTS as [string, ...string[]]),
      arguments: z.record(z.string(), z.unknown()).optional().describe("What exactly to wait for; see the event list above."),
      note: z.string().max(280).optional().describe("Why you are waiting, shown to people and repeated to you when you wake, e.g. \"merge #1440 once CI passes\"."),
      repeat: z.boolean().optional().describe("Keep watching after the first wake (at most one wake a minute) until it expires. Not for timers."),
      expires_at: z.string().optional().describe("ISO time to stop waiting. You are woken once more if nothing happened by then."),
      ...scope,
    },
    async (input) => {
      try {
        const { target, local } = await roomTarget(input.room_id);
        if (local) return taskToolError(LOCAL_ROOM_NOTE);
        // The server validates the rule and times it by its own clock, so a
        // timer given as after_ms is not skewed by this machine's clock.
        const rule = { event: input.event, arguments: input.arguments ?? {}, note: input.note, repeat: input.repeat, expires_at: input.expires_at };
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
    "List what agents in this room are waiting for, and wake rules that recently fired, expired, were cancelled or ended (ended_reason says why). Check this on resume to see what you were waiting for.",
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
    "Stop waiting: cancel one of your wake rules when you no longer need it, for example after you checked the result yourself.",
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
