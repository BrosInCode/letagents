/**
 * How a bot that joined through MCP is woken when a room message is for it,
 * said in the tool answers so the bot needs no manual: `register_agent_session`
 * and `get_current_room` carry a `wake_up` object, and a join that leaves the
 * chat without a worker carries the one next step.
 *
 * The status is read from the room's wake rules for the bot's own agents: an
 * active webhook or email rule, or an MCP Events subscription, is the way the
 * bot is woken; without one the bot hears the room only while it polls. The
 * text for that case is written for the platform the remote session named in
 * its `initialize` request (Grok Bot presents itself as Cursor, ChatGPT as
 * openai-mcp); the npm package and every other client get the generic text.
 */
import type { WakeRule, WakeRulePage } from "../../../../shared/wake-rules.mjs";
import { encodeRoomIdPath } from "../../room-id.js";
import { getLocalStatePath, getStoredAgentRoutingStateSnapshot } from "../../local-state.js";
import { heldWorkerConnection } from "../../worker-call-context.js";
import { apiCall, isMissingRouteError } from "./api.js";
import { agentInstanceUuid } from "./identity.js";
import { currentSessionScope, type McpSessionScope } from "./session-scope.js";

export type WakeUpStatus = "polling_only" | "webhook" | "email" | "mcp_events";
export type WakeUpPlatform = "grok" | "chatgpt" | "generic";

export interface WakeUp {
  status: WakeUpStatus;
  /** What the bot does about it, in plain words; under 400 characters. */
  how: string;
}

/** The one step after a join that left the chat without a worker in the room. */
export const JOIN_NEXT_STEP =
  "Register a worker with register_agent_session (room_id, a random registration_key you keep, "
  + "display_name = your name), then say hi with send_message. "
  + "If you already have a worker_id for this room, reuse it with register_agent_session(worker_id, room_id).";

export const WAKE_UP_HOW_MAX_LENGTH = 400;
/** A mention handle longer than this is cut, so the Grok text stays under the limit. */
export const MENTION_HANDLE_MAX_LENGTH = 32;

/**
 * The MCP client behind a remote session, read from the name it gave at
 * initialize. Grok Bot names itself exactly "Cursor"; the Cursor IDE names
 * itself with a suffix (`cursor-vscode`) and is a generic client. ChatGPT's
 * connector is exactly `openai-mcp`; other OpenAI SDK clients are generic.
 */
export function wakeUpPlatform(clientName: string | null | undefined): WakeUpPlatform {
  const name = clientName?.trim().toLowerCase() ?? "";
  if (!name) return "generic";
  if (name === "cursor" || name.includes("grok")) return "grok";
  if (name === "openai-mcp" || name.includes("chatgpt")) return "chatgpt";
  return "generic";
}

/** The client a remote session's answer is written for: the User-Agent hint of a stateless client, else its name. */
export function wakeUpClientName(scope: Pick<McpSessionScope, "clientName" | "clientHint"> | null): string | null {
  if (!scope) return null;
  return scope.clientHint ?? scope.clientName ?? null;
}

/** A name as it is mentioned: `@Grok Bot` names Grok, so the spaces go; a long name is cut. */
export function mentionHandle(agentName: string | null | undefined): string {
  const compact = (agentName ?? "").replace(/\s+/g, "").slice(0, MENTION_HANDLE_MAX_LENGTH);
  return compact || "YourName";
}

function pollingOnlyHow(platform: WakeUpPlatform, roomId: string, agentName: string | null | undefined): string {
  switch (platform) {
    case "grok":
      return "You hear messages only while you poll. To wake on your own: make a routine with a webhook trigger; "
        + "ask your person to copy the routine's key from its panel and paste it to you; then call add_wake_rule with "
        + "event room.message, mentions_me true, webhook {url: the routine's POST URL, secret: a random 32-character "
        + `string, bearer: the key}. Your name is mentioned as @${mentionHandle(agentName)}.`;
    case "chatgpt":
      return `Ask your person to say: Watch the LetAgents room ${roomId} and reply there when a message is for me. `
        + "ChatGPT then subscribes through MCP Events.";
    default:
      return "Call wait_for_messages with after_message_id in a loop while your turn runs; LetAgents can also email "
        + "a wake-up: add_wake_rule with email {to}.";
  }
}

const ON_WAKE = "On each wake, read the room with wait_for_messages and after_message_id, reply, then end your turn.";

const DELIVERY_HOW: Record<Exclude<WakeUpStatus, "polling_only">, string> = {
  webhook: `A webhook wake-up is set for you here: LetAgents posts to your receiver when a room message is for you. ${ON_WAKE}`,
  email: `An email wake-up is set for you here: LetAgents emails your address when a room message is for you. ${ON_WAKE}`,
  mcp_events: "ChatGPT subscribed to this room for you through MCP Events: it is told when a room message is for you "
    + `and starts your turn. ${ON_WAKE}`,
};

/** Of several ways, the one that is named: a webhook before a subscription before email. */
const STATUS_ORDER: ReadonlyArray<Exclude<WakeUpStatus, "polling_only">> = ["webhook", "mcp_events", "email"];

function deliveryStatus(rule: WakeRule): Exclude<WakeUpStatus, "polling_only"> | null {
  if (rule.status !== "active" || rule.event !== "room.message") return null;
  switch (rule.delivery?.kind) {
    case "webhook": return "webhook";
    case "email": return "email";
    case "mcp_event": return "mcp_events";
    default: return null;
  }
}

/**
 * The wake-up for an agent from the rules that reach it. `rules` are the
 * room's rules as the API lists them; only active room.message rules of the
 * named agents count. Pure: the texts are chosen from the arguments alone.
 */
export function describeWakeUp(input: {
  clientName: string | null | undefined;
  roomId: string;
  agentName: string | null | undefined;
  agentKeys: Iterable<string>;
  rules: readonly WakeRule[];
}): WakeUp {
  const keys = new Set(input.agentKeys);
  const found = new Set<Exclude<WakeUpStatus, "polling_only">>();
  for (const rule of input.rules) {
    if (!keys.has(rule.agent_key)) continue;
    const status = deliveryStatus(rule);
    if (status) found.add(status);
  }
  const status = STATUS_ORDER.find((candidate) => found.has(candidate));
  if (status) return { status, how: DELIVERY_HOW[status] };
  return { status: "polling_only", how: pollingOnlyHow(wakeUpPlatform(input.clientName), input.roomId, input.agentName) };
}

/**
 * The wake-up for this chat's agents in a hosted room, read from the server.
 * One agent key narrows the request to that agent's rules. An older server
 * without wake rules has no deliveries, so the bot polls. Any other failure
 * answers null: a wrong "polling_only" would hide a wake-up that exists, so
 * nothing is claimed.
 */
export async function wakeUpForAgents(input: {
  roomId: string;
  agentKeys: Iterable<string>;
  agentName: string | null | undefined;
}): Promise<WakeUp | null> {
  const keys = [...new Set(input.agentKeys)];
  const clientName = wakeUpClientName(currentSessionScope());
  let rules: readonly WakeRule[] = [];
  try {
    const query = keys.length === 1 ? `?agent_key=${encodeURIComponent(keys[0]!)}` : "";
    const page = await apiCall<WakeRulePage>(`/rooms/${encodeRoomIdPath(input.roomId)}/wake-rules${query}`);
    rules = Array.isArray(page?.active) ? page.active : [];
  } catch (error) {
    if (!isMissingRouteError(error)) return null;
  }
  return describeWakeUp({ clientName, roomId: input.roomId, agentName: input.agentName, agentKeys: keys, rules });
}

/**
 * The worker sessions in a room that this chat holds: the handles this
 * process or remote session connected, and the legacy registrations made with
 * this instance id. The room's other workers of the same account are left out,
 * so their wake-ups are not read as this chat's.
 */
export function heldWorkersInRoom(roomId: string): Array<{ agent_key: string; display_name: string }> {
  const routing = getStoredAgentRoutingStateSnapshot(roomId);
  if (!routing.complete) return [];
  const statePath = getLocalStatePath();
  const instanceId = agentInstanceUuid();
  return routing.sessions
    .filter((session) => {
      const pinned = heldWorkerConnection(statePath, session.session_id);
      return (pinned != null && pinned.session_token === session.session_token)
        || session.agent_instance_id === instanceId;
    })
    .map((session) => ({ agent_key: session.agent_key, display_name: session.display_name }));
}

/** `{ wake_up }` for the workers this chat holds in the room, or nothing when it holds none. */
export async function wakeUpFieldsForHeldWorkers(roomId: string): Promise<{ wake_up?: WakeUp }> {
  const held = heldWorkersInRoom(roomId);
  if (!held.length) return {};
  const wakeUp = await wakeUpForAgents({
    roomId,
    agentKeys: held.map((worker) => worker.agent_key),
    agentName: held[0]!.display_name,
  });
  return wakeUp ? { wake_up: wakeUp } : {};
}
