import type { Message } from "../../../db.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { ResolvedRequestAgentIdentity } from "../../../request/agent-identity.js";
import type { RoomEventBroker } from "../../../server/room-event-broker.js";
import type {
  RoomMessageAccountOverlay,
  RoomMessageOverlayBatcher,
  RoomMessageOverlayTarget,
} from "../../../server/room-message-overlays.js";
import { attachAccountRoutingAuthorityActivation } from "./receipt-activation.js";
import { isDesktopHumanClient } from "./request-identity.js";
import { isPromptOnlyAgentMessage } from "../../../../shared/room-agent-prompts.js";
import { parseScopedId } from "../../../db/utils.js";

export function resolveLiveMessageOverlayTarget(
  req: AuthenticatedRequest,
  identity: ResolvedRequestAgentIdentity | null,
): RoomMessageOverlayTarget | undefined {
  if (identity?.session_kind === "worker") {
    const accountId = identity.owner_account_id?.trim();
    if (!accountId) return undefined;
    return { accountId, accountAgentRouting: true };
  }
  const accountId = req.sessionAccount?.account_id?.trim();
  return accountId
    ? { accountId, accountAgentRouting: isDesktopHumanClient(req) }
    : undefined;
}

/** Hydrate only subscriber-specific overlays; the canonical body stays shared. */
export async function hydrateLiveMessageForSubscriber(input: {
  roomId: string;
  message: Message;
  identity: ResolvedRequestAgentIdentity | null;
  target: RoomMessageOverlayTarget | undefined;
  broker: RoomEventBroker;
  batcher: RoomMessageOverlayBatcher;
  /** Gap catch-up filters a valid silent prompt while retaining cursor progress. */
  allowSilentPromptOnly?: boolean;
}): Promise<Message> {
  if (input.identity?.session_kind === "worker" && !input.target) {
    throw new Error("worker routing account is unavailable");
  }
  if (!input.target) return input.message;
  const overlays = await input.batcher.prepare({
    roomId: input.roomId,
    message: input.message,
    targets: input.broker.getMessageOverlayTargets(input.roomId),
  });
  const overlay = overlays.get(input.target.accountId);
  if (!overlay) throw new Error("subscriber account overlay is unavailable");
  if (input.target.accountAgentRouting && !overlay.account_agent_routing) {
    throw new Error("subscriber routing authority is unavailable");
  }
  return applyLiveMessageOverlay(input.message, overlay, input.identity, input.target, {
    allowSilentPromptOnly: input.allowSilentPromptOnly,
  });
}

/** Hydrate a durable gap page with one routing/read plan, then project per row in memory. */
export async function hydrateLiveMessagesForSubscriber(input: {
  roomId: string;
  messages: readonly Message[];
  identity: ResolvedRequestAgentIdentity | null;
  target: RoomMessageOverlayTarget | undefined;
  broker: RoomEventBroker;
  batcher: RoomMessageOverlayBatcher;
  allowSilentPromptOnly?: boolean;
}): Promise<Message[]> {
  if (input.identity?.session_kind === "worker" && !input.target) {
    throw new Error("worker routing account is unavailable");
  }
  if (!input.target || input.messages.length === 0) return [...input.messages];
  const overlaysByMessage = await input.batcher.prepareMany({
    roomId: input.roomId,
    messages: input.messages,
    targets: input.broker.getMessageOverlayTargets(input.roomId),
    target: input.target,
  });
  return input.messages.map((message) => {
    const messageNumber = parseScopedId(message.id, "msg");
    if (!messageNumber) throw new Error("invalid broker message id");
    const overlay = overlaysByMessage.get(messageNumber)?.get(input.target!.accountId);
    if (!overlay) throw new Error("subscriber account overlay is unavailable");
    if (input.target!.accountAgentRouting && !overlay.account_agent_routing) {
      throw new Error("subscriber routing authority is unavailable");
    }
    return applyLiveMessageOverlay(message, overlay, input.identity, input.target!, {
      allowSilentPromptOnly: input.allowSilentPromptOnly,
    });
  });
}

function applyLiveMessageOverlay(
  message: Message,
  overlay: RoomMessageAccountOverlay,
  identity: ResolvedRequestAgentIdentity | null,
  target: RoomMessageOverlayTarget,
  options: { allowSilentPromptOnly?: boolean },
): Message {
  const withReadOverlay: Message = {
    ...message,
    ...(message.thread && overlay.thread_read
      ? { thread: { ...message.thread, ...overlay.thread_read } }
      : {}),
  };
  if (identity?.session_kind === "worker") {
    const attached = attachAccountRoutingAuthorityActivation(
      withReadOverlay,
      identity,
      overlay.account_agent_routing!,
    );
    // The broker's compact exact audience is the first confidentiality fence.
    // Receipt successor authority depends on live session state, so re-check
    // the freshly batched account envelope immediately before serialization.
    // This closes the transition where a formerly sole successor becomes
    // ambiguous after the canonical/ref event entered the broker buffer.
    if (
      !options.allowSilentPromptOnly
      &&
      isPromptOnlyAgentMessage(attached.text, attached.agent_prompt_kind)
      && (attached as Message & {
        activation?: { for_current_agent?: { decision?: string } };
      }).activation?.for_current_agent?.decision !== "activate"
    ) {
      throw new Error("prompt-only subscriber authority is no longer active");
    }
    return attached;
  }
  return target.accountAgentRouting
    ? { ...withReadOverlay, account_agent_routing: overlay.account_agent_routing }
    : withReadOverlay;
}

export function isMessageVisibleToCurrentWorker(message: Message): boolean {
  if (!isPromptOnlyAgentMessage(message.text, message.agent_prompt_kind)) return true;
  return (message as Message & {
    activation?: { for_current_agent?: { decision?: string } };
  }).activation?.for_current_agent?.decision === "activate";
}
