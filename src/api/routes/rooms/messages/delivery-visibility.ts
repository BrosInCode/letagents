import { isPromptOnlyAgentMessage } from "../../../../shared/room-agent-prompts.js";
import {
  recipientAgentDurableTargetKey,
  type RoomEvent,
} from "../../../server/room-event-broker.js";

/**
 * Filters before a shared event enters a subscriber queue. Prompt-only frames
 * are delivery control messages, not shared transcript, and therefore require
 * the account-scoped durable receipt audience in addition to explicit opt-in.
 * Exact generation authority is revalidated immediately before serialization.
 */
export function isRoomEventVisibleToSubscriber(input: {
  event: RoomEvent;
  includePromptOnly: boolean;
  recipientAgentIdentity?: {
    owner_account_id?: string | null;
    agent_key?: string | null;
    agent_session_id?: string | null;
  } | null;
  messageOnly?: boolean;
}): boolean {
  const { event } = input;
  if (input.messageOnly && event.kind !== "message_created") return false;
  if (event.kind === "message_created") {
    if (!isPromptOnlyAgentMessage(event.message.text, event.message.agent_prompt_kind)) return true;
    const durableTarget = input.recipientAgentIdentity
      ? recipientAgentDurableTargetKey(input.recipientAgentIdentity)
      : null;
    return Boolean(input.includePromptOnly
      && durableTarget
      && event.recipientAgentTargetSet.has(durableTarget));
  }
  return event.kind !== "rental_activity_created"
    || event.activity.visibility === "rental_visible";
}
