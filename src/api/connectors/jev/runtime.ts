/**
 * The Jev services on the server's database, rule engine and board intents
 * (ticket connectors PR6). Imported lazily from the webhook path, so a server
 * without a tracker connection loads none of this.
 */
import { randomUUID } from "node:crypto";

import { db } from "../../db/client.js";
import { approveBoardIntent, claimBoardIntentEscalationTx, createBoardIntent, denyBoardIntent } from "../../db/coordination/board-intents.js";
import { getActiveTaskLocks } from "../../db/coordination/task-locks.js";
import { getTaskById, updateTask } from "../../db/tasks.js";
import type { Task } from "../../db/types.js";
import { readJevEndpoint } from "../../messages/jev-conversation-routing.js";
import { getCachedRoomTrackerScope } from "../room-filters.js";
import { getDefaultTrackerRuleEngine } from "../rules/engine.js";
import { createJevLinkService, type JevLinkService } from "../jev-link.js";
import { proposeForClosedPullRequest, type JevExceptionDeps } from "./exceptions.js";
import {
  externalItemsByKey,
  fetchPullRequestCommitSubjects,
  findAuthorTrackerUserId,
  findCardHoldingPullRequest,
  findRoomJevConnection,
  findRoomJevConnections,
  listJevLinkCandidates,
} from "./lookups.js";
import { askJevNeedsMe, findNeedsMeCard, readNeedsMeMessages } from "./needs-me.js";
import { draftRuleFromSentence } from "./rule-draft.js";
import { JEV_LINK_INTENT_TYPE, jevIntentStore, jevQuestionStore } from "./store.js";

async function emitTaskUpdated(roomId: string, task: Task): Promise<void> {
  try {
    const { taskEvents } = await import("../../server/events.js");
    taskEvents.emit("task:updated", { projectId: roomId, task });
  } catch {
    // Open boards catch up on their next read.
  }
}

async function postRoomStatus(input: { roomId: string; task: Task; text: string; clientMessageId: string }): Promise<void> {
  const { emitTaskAnchoredMessage } = await import("../../server/room-services.js");
  await emitTaskAnchoredMessage(input.roomId, "letagents", input.text, input.task, { client_message_id: input.clientMessageId });
}

/**
 * Invariant 1: a room with no ticket filter pays no query here (the scope is
 * cached for 30 s), and only a filter whose connection has the Jev switch on
 * can lead to a Jev call (invariant 7).
 */
const roomJevConnection: typeof findRoomJevConnection = async (roomId, provider) => {
  const scope = await getCachedRoomTrackerScope(roomId);
  if (!scope.sources.some((source) => !provider || source.provider === provider)) return null;
  return findRoomJevConnection(roomId, provider);
};

const roomJevConnections: typeof findRoomJevConnections = async (roomId, provider) => {
  const scope = await getCachedRoomTrackerScope(roomId);
  if (!scope.sources.some((source) => !provider || source.provider === provider)) return [];
  return findRoomJevConnections(roomId, provider);
};

let linkService: JevLinkService | null = null;

export function getDefaultJevLinkService(): JevLinkService {
  if (linkService) return linkService;
  linkService = createJevLinkService({
    endpoint: () => readJevEndpoint(),
    questions: jevQuestionStore,
    intents: jevIntentStore,
    roomJevConnections: (roomId) => roomJevConnections(roomId),
    cardHoldingPullRequest: findCardHoldingPullRequest,
    authorTrackerUserId: findAuthorTrackerUserId,
    candidates: listJevLinkCandidates,
    commitSubjects: fetchPullRequestCommitSubjects,
    getTask: getTaskById,
    cardLocked: async (roomId, taskId) => (await getActiveTaskLocks(roomId, taskId)).length > 0,
    writeArtifacts: async (roomId, taskId, artifacts) => {
      const task = await updateTask(roomId, taskId, { workflow_artifacts: artifacts });
      if (task) await emitTaskUpdated(roomId, task);
      return task;
    },
    previewRules: async (input) => (await getDefaultTrackerRuleEngine()).previewForRepoEvent(input),
    runApprovedPlan: async (input) => (await getDefaultTrackerRuleEngine()).runApprovedPlan(input),
    createIntent: async (input) => {
      const intent = await createBoardIntent({
        room_id: input.room_id,
        action_type: JEV_LINK_INTENT_TYPE,
        task_id: input.task_id,
        payload: input.payload,
        proposer_actor_label: "jev",
      });
      // The room message already asks a person; the vacancy sweep must not announce it again.
      await claimBoardIntentEscalationTx(db, { room_id: input.room_id, intent_id: intent.id }).catch(() => undefined);
      return intent;
    },
    approveIntent: async (input) => (await approveBoardIntent(input))?.intent ?? null,
    denyIntent: denyBoardIntent,
    postMessage: postRoomStatus,
  });
  return linkService;
}

const exceptionDeps: JevExceptionDeps = {
  endpoint: () => readJevEndpoint(),
  questions: jevQuestionStore,
  roomJevConnection,
  ticketTitle: async (connectionId, key) => (await externalItemsByKey(connectionId, [key])).get(key)?.title ?? null,
  postMessage: postRoomStatus,
};

export function proposeForClosedPullRequestDefault(input: Parameters<typeof proposeForClosedPullRequest>[1]) {
  return proposeForClosedPullRequest(exceptionDeps, input);
}

let lastPruneAt = 0;
const PRUNE_EVERY_MS = 60 * 60_000;

/** The 90-day sweep of Jev question rows, at most once an hour per process; a rejected link's row stays. */
export async function pruneJevQuestions(now = Date.now()): Promise<number> {
  if (now - lastPruneAt < PRUNE_EVERY_MS) return 0;
  lastPruneAt = now;
  return jevQuestionStore.prune(new Date(now));
}

export function askJevNeedsMeDefault(input: { roomId: string; taskId: string }) {
  return askJevNeedsMe({
    endpoint: () => readJevEndpoint(),
    questions: jevQuestionStore,
    card: findNeedsMeCard,
    messages: readNeedsMeMessages,
  }, input);
}

export function draftRuleFromSentenceDefault(input: Parameters<typeof draftRuleFromSentence>[1]) {
  return draftRuleFromSentence({
    endpoint: () => readJevEndpoint(),
    questions: jevQuestionStore,
    newId: () => `draft_${randomUUID()}`,
  }, input);
}
