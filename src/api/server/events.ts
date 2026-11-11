import type { RoomGif } from "../../../shared/room-expressions.mjs";
import {
  addMessageWithCreateStatus,
  type AddMessageOptions,
  type Message,
} from "../db.js";
import { createBridgedEmitter } from "./event-bridge.js";
import {
  resolveGitHubNotifyAccountIds,
  type GitHubUserReference,
} from "../db/auth/find-account-by-github.js";
import { getProjectById } from "../db/rooms.js";
import {
  authorizeDesktopPushNotification,
  type DesktopPushAuthorizationDecision,
} from "../notifications/authorization.js";
import {
  isHiddenAgentStatusMessage,
  resolveMentionedAccountIds,
} from "../notifications/mention-accounts.js";
import { getPushDeliveryAccount } from "../notifications/push-account.js";
import { announceRoomMentionCreated } from "../rooms/mention-events.js";
import type { NormalizedMessageAttachmentReference } from "../messages/attachments.js";
import type { MessageRecipientAgentTarget } from "../db/types.js";
import {
  isPromptOnlyAgentMessage,
  type AgentPromptKind,
} from "../../shared/room-agent-prompts.js";

export interface MessageCreatedEvent {
  projectId: string;
  message: Message;
  recipientAgentTargets: readonly MessageRecipientAgentTarget[];
}

/**
 * Routing authority appended after the message committed (deferred
 * conversation routing). Same body as the original message; only the exact
 * new audience is meant to learn of it.
 */
export interface MessageRoutedEvent {
  projectId: string;
  message: Message;
  recipientAgentTargets: readonly MessageRecipientAgentTarget[];
}

export const contentDeletionEvents = createBridgedEmitter("content-deletions");
export const messageEvents = createBridgedEmitter("messages");
export const taskEvents = createBridgedEmitter("tasks");
export const githubRoomEvents = createBridgedEmitter("github");
export const reasoningEvents = createBridgedEmitter("reasoning");
export const artifactEvents = createBridgedEmitter("artifacts");
export const agentWorkEvents = createBridgedEmitter("agent-work");
export const agentApprovalEvents = createBridgedEmitter("agent-approval");
export const executionDelegationEvents = createBridgedEmitter("execution-delegation");
export const wakeRuleEvents = createBridgedEmitter("wake-rules");
export const messagePinEvents = createBridgedEmitter("message-pins");
export const messageReactionEvents = createBridgedEmitter("message-reactions");

const ROOM_INVALIDATION_COALESCE_MS = 100;

function createRoomInvalidationQueue(
  emitter: ReturnType<typeof createBridgedEmitter>,
  eventName: string,
) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  return (projectId: string): void => {
    if (pending.has(projectId)) return;
    const timer = setTimeout(() => {
      pending.delete(projectId);
      emitter.emit(eventName, { projectId });
    }, ROOM_INVALIDATION_COALESCE_MS);
    timer.unref?.();
    pending.set(projectId, timer);
  };
}

/**
 * Coalesce retained-work mutations into a pointer-only room invalidation.
 * Consumers always repair through the authoritative agent-work poll endpoint.
 */
export const queueAgentWorkInvalidation = createRoomInvalidationQueue(
  agentWorkEvents,
  "agent_work:invalidated",
);

/**
 * Coalesce approval mutations into a pointer-only room invalidation.
 * Consumers repair through the separately authorized approval read path.
 */
export const queueAgentApprovalInvalidation = createRoomInvalidationQueue(
  agentApprovalEvents,
  "agent_approval:invalidated",
);

/**
 * Coalesce committed delegation mutations into a pointer-only room hint.
 * Host authority is always repaired through the authenticated exact routes.
 */
export const queueExecutionDelegationInvalidation = createRoomInvalidationQueue(
  executionDelegationEvents,
  "execution_delegation:invalidated",
);

/**
 * Coalesce wake-rule changes (created, fired, expired, cancelled) into a
 * pointer-only room invalidation. Consumers re-read the room's wake rules.
 */
export const queueWakeRuleInvalidation = createRoomInvalidationQueue(
  wakeRuleEvents,
  "wake_rules:invalidated",
);

/**
 * Coalesce reaction changes into a pointer-only room invalidation. Consumers
 * re-read the reactions of the messages they show. A reaction is never
 * published as a message, so it cannot wake an agent or notify anyone.
 */
export const queueMessageReactionInvalidation = createRoomInvalidationQueue(
  messageReactionEvents,
  "message_reactions:invalidated",
);

/** A pin changes a read model, never the message/notification/agent stream. */
export const queueMessagePinInvalidation = createRoomInvalidationQueue(messagePinEvents, "message_pins:invalidated");

export type AccountRoomAccessResolver = (input: {
  accountId: string;
  roomId: string;
}) => Promise<DesktopPushAuthorizationDecision>;

/**
 * The production decision on the emit path. It uses the cached collaborator
 * check, not a fresh one. The push worker does the fresh check at delivery.
 */
export const resolveAccountRoomAccessForEmit: AccountRoomAccessResolver = (input) =>
  authorizeDesktopPushNotification({ ...input, freshCollaboratorCheck: false }, {
    getProject: getProjectById,
    getAccount: getPushDeliveryAccount,
  });

export interface AccountIdsWithRoomAccess {
  /** Accounts that may get a targeted push. Includes accounts that must be re-checked at delivery. */
  notify: string[];
  /** Accounts that may get a recents row. Only accounts with a confirmed allow. */
  recents: string[];
}

/**
 * Keeps the accounts that may read the room: members of a room that is not
 * backed by a repository, people with access to a repo room. An allow goes to
 * both lists. A retry goes
 * only to notify, because the push worker checks again before it sends. A deny
 * goes to neither list. A thrown error drops the account and never fails the message.
 */
export async function filterAccountIdsWithRoomAccess(
  projectId: string,
  accountIds: readonly string[],
  resolveAccess: AccountRoomAccessResolver = resolveAccountRoomAccessForEmit,
): Promise<AccountIdsWithRoomAccess> {
  const notify: string[] = [];
  const recents: string[] = [];
  for (const accountId of accountIds) {
    let decision: DesktopPushAuthorizationDecision;
    try {
      decision = await resolveAccess({ accountId, roomId: projectId });
    } catch (error) {
      console.warn(
        `[room-access] push access check failed account=${accountId} room=${projectId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }
    if (decision === "allow") {
      notify.push(accountId);
      recents.push(accountId);
    } else if (decision === "retry") {
      notify.push(accountId);
    }
  }
  return { notify, recents };
}

export interface MessageNotificationTargetInput {
  projectId: string;
  text: string;
  source?: string | null;
  agent_prompt_kind?: AgentPromptKind | null;
  addressed_to?: AddMessageOptions["addressed_to"];
  account_id?: string | null;
  publisher_agent_key?: string | null;
  notify_github_users?: readonly GitHubUserReference[];
}

export interface MessageNotificationTargetDeps {
  resolveGitHubAccounts?: (users: readonly GitHubUserReference[] | undefined) => Promise<string[]>;
  resolveMentionAccounts?: (text: string, excludeAccountId: string | null) => Promise<string[]>;
  resolveAccess?: AccountRoomAccessResolver;
}

export interface ResolvedMessageNotificationTargets {
  notify_account_ids: string[];
  recents_account_ids: string[];
  mention_notify_account_ids: string[];
  human_publisher_account_id: string | null;
}

export async function resolveMessageNotificationTargets(
  input: MessageNotificationTargetInput,
  deps?: MessageNotificationTargetDeps,
): Promise<ResolvedMessageNotificationTargets> {
  const humanPublisherAccountId = input.publisher_agent_key
    ? null
    : (input.account_id?.trim() || null);

  if (
    isPromptOnlyAgentMessage(input.text, input.agent_prompt_kind ?? null)
    || Boolean(input.addressed_to)
    || isHiddenAgentStatusMessage(input.source, input.text)
  ) {
    return {
      notify_account_ids: [],
      recents_account_ids: [],
      mention_notify_account_ids: [],
      human_publisher_account_id: humanPublisherAccountId,
    };
  }

  const resolveGitHubAccounts = deps?.resolveGitHubAccounts ?? resolveGitHubNotifyAccountIds;
  const resolveMentionAccounts = deps?.resolveMentionAccounts
    ?? ((messageText: string, excludeAccountId: string | null) =>
      resolveMentionedAccountIds(messageText, { excludeAccountId }));
  const resolveAccess = deps?.resolveAccess ?? resolveAccountRoomAccessForEmit;

  try {
    const [githubAccountIds, mentionAccountIds] = await Promise.all([
      input.notify_github_users?.length
        ? resolveGitHubAccounts(input.notify_github_users).catch((error) => {
            console.warn(
              `[room-access] github notify lookup failed room=${input.projectId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return [] as string[];
          })
        : Promise.resolve([] as string[]),
      input.source === "github"
        ? Promise.resolve([] as string[])
        : resolveMentionAccounts(input.text, humanPublisherAccountId).catch((error) => {
            console.warn(
              `[room-access] mention notify lookup failed room=${input.projectId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return [] as string[];
          }),
    ]);

    const candidateAccountIds = [
      ...new Set(
        [...githubAccountIds, ...mentionAccountIds].filter(
          (accountId) => Boolean(accountId) && accountId !== humanPublisherAccountId,
        ),
      ),
    ];
    if (candidateAccountIds.length === 0) {
      return {
        notify_account_ids: [],
        recents_account_ids: [],
        mention_notify_account_ids: [],
        human_publisher_account_id: humanPublisherAccountId,
      };
    }

    const access = await filterAccountIdsWithRoomAccess(input.projectId, candidateAccountIds, resolveAccess);
    const mentionSet = new Set(mentionAccountIds);
    return {
      notify_account_ids: access.notify,
      recents_account_ids: access.recents,
      mention_notify_account_ids: access.notify.filter((accountId) => mentionSet.has(accountId)),
      human_publisher_account_id: humanPublisherAccountId,
    };
  } catch (error) {
    console.warn(
      `[room-access] notify lookup failed room=${input.projectId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      notify_account_ids: [],
      recents_account_ids: [],
      mention_notify_account_ids: [],
      human_publisher_account_id: humanPublisherAccountId,
    };
  }
}

export async function emitProjectMessage(
  projectId: string,
  sender: string,
  text: string,
  options?: {
    source?: string;
    display_text?: string | null;
    agent_prompt_kind?: AgentPromptKind | null;
    reply_to?: string | null;
    thread_root_id?: string | null;
    gif?: RoomGif | null;
    attachments?: NormalizedMessageAttachmentReference[];
    attachment_uploader?: AddMessageOptions["attachment_uploader"];
    client_message_id?: string | null;
    publisher_agent_key?: string | null;
    publisher_agent_session_id?: string | null;
    account_id?: string | null;
    account_agent_routing?: boolean;
    with_created_message_in_transaction?: AddMessageOptions["with_created_message_in_transaction"];
    addressed_to?: AddMessageOptions["addressed_to"];
    notify_github_users?: Array<{ login: string; github_user_id: string | null }>;
  }
): Promise<Message> {
  const notified = await resolveMessageNotificationTargets({
    projectId,
    text,
    source: options?.source,
    agent_prompt_kind: options?.agent_prompt_kind ?? null,
    addressed_to: options?.addressed_to,
    account_id: options?.account_id ?? null,
    publisher_agent_key: options?.publisher_agent_key ?? null,
    notify_github_users: options?.notify_github_users,
  });
  const {
    message,
    canonical_message: canonicalMessage,
    created,
    recipientAgentTargets,
  } = await addMessageWithCreateStatus(projectId, sender, text, {
    notify_account_ids: notified.notify_account_ids,
    recents_account_ids: notified.recents_account_ids,
    source: options?.source,
    display_text: options?.display_text,
    agent_prompt_kind: options?.agent_prompt_kind ?? null,
    reply_to_message_id: options?.reply_to ?? null,
    thread_root_message_id: options?.thread_root_id ?? null,
    attachments: options?.attachments,
    attachment_uploader: options?.attachment_uploader ?? null,
    gif: options?.gif,
    client_message_id: options?.client_message_id ?? null,
    publisher_agent_key: options?.publisher_agent_key ?? null,
    publisher_agent_session_id: options?.publisher_agent_session_id ?? null,
    account_id: options?.account_id ?? null,
    account_agent_routing: options?.account_agent_routing,
    with_created_message_in_transaction: options?.with_created_message_in_transaction,
    addressed_to: options?.addressed_to,
  });
  if (created) {
    messageEvents.emit("message:created", {
      projectId,
      message: canonicalMessage,
      recipientAgentTargets: isPromptOnlyAgentMessage(
        canonicalMessage.text,
        canonicalMessage.agent_prompt_kind,
      ) ? recipientAgentTargets ?? [] : [],
    } satisfies MessageCreatedEvent);

    if (notified.mention_notify_account_ids.length > 0) {
      void getProjectById(projectId)
        .then((project) => project?.display_name ?? "")
        .catch(() => "")
        .then((roomDisplayName) => {
          announceRoomMentionCreated({
            projectId,
            roomDisplayName,
            messageId: canonicalMessage.id,
            threadRootId: canonicalMessage.thread_reply_to_id ? canonicalMessage.thread_root_id : null,
            targetAccountIds: notified.mention_notify_account_ids,
            publisherAccountId: notified.human_publisher_account_id,
          });
        });
    }
  }
  return message;
}
