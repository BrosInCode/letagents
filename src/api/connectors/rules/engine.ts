import { and, eq, inArray, like, sql } from "drizzle-orm";

import { isTrackerSyncEvent, TRACKER_RULE_MAX_ACTIONS, type TrackerProvider } from "../../../../shared/ticket-connectors.mjs";
import { db } from "../../db/client.js";
import { external_items, github_room_events, room_tracker_filters, tasks, tracker_connections } from "../../db/schema.js";
import type { Task } from "../../db/types.js";
import { parseScopedId } from "../../db/utils.js";
import type { WorkflowEffect } from "../../db/types/effects.js";
import type { RepoRoomEvent } from "../../repo-workflow/types.js";
import type { ReserveResult, SubmitTrackerEffectInput } from "../../workflow-effects/broker.js";
import { parseExternalRef } from "../key-detectors.js";
import { getCachedRoomTrackerScope, type RoomTrackerScope } from "../room-filters.js";
import { matchTrackerRules, rulesNeedApprovalCount, type TrackerRuleEventFacts } from "./matcher.js";
import {
  trackerRuleStore,
  type LoadedTrackerRule,
  type TrackerRuleRunRow,
  type TrackerRuleSkipReason,
  type TrackerRuleStore,
} from "./store.js";
import { renderTrackerRuleTemplate, type TrackerRuleTemplateValues } from "./template.js";

/** One tracker write a rule run planned: what the journal row will request. */
export type PlannedTrackerAction =
  | { kind: "tracker_transition"; to_status: string }
  | { kind: "tracker_comment"; body: string };

/** The connection a room imports a tracker's tickets with, and its owner. */
export interface RoomRuleConnection {
  connection_id: string;
  account_id: string;
  provider: TrackerProvider;
}

export interface TrackerRuleEngineDeps {
  store: Pick<TrackerRuleStore, "forRoom" | "claimRun" | "getRun" | "appendEffect" | "finishRun" | "pendingRuns">;
  /** Cached; one indexed query per room every 30 s, none for most rooms. */
  roomScope(roomId: string): Promise<RoomTrackerScope>;
  /** The room's enabled filter for this tracker, set by the connection's owner, on an active connection. */
  roomConnection(roomId: string, provider: TrackerProvider): Promise<RoomRuleConnection | null>;
  /**
   * Whether sync bound the card to this ticket through this connection. Sync
   * binds a card only in a room whose filter matched the ticket, so a key
   * typed onto a card by hand cannot aim the owner's rules at another ticket.
   */
  ticketBound(input: { connectionId: string; roomId: string; taskId: string; key: string }): Promise<boolean>;
  /** Whether the connection's owner is still an admin of the room (a filter outlives a role). */
  ownerIsRoomAdmin(roomId: string, accountId: string): Promise<boolean>;
  /** Reviewers from the repository whose latest review of the pull request approves it. */
  countApprovals(input: { roomIds: string[]; pullNumber: number; pullUrl: string }): Promise<number>;
  /** The broker's `reserveTrackerEffect`: every tracker write goes through the journal (invariant 3). */
  reserve(input: SubmitTrackerEffectInput): Promise<ReserveResult>;
  /** The broker's `driveTrackerEffect`. */
  drive(reserved: ReserveResult): Promise<WorkflowEffect>;
  getEffect(id: string): Promise<WorkflowEffect | null>;
  /**
   * Runs the tracker calls after the webhook answers: one can take up to
   * 15 s. The first journal row is reserved before, so a crash in between
   * leaves a pending row that the sweep reconciles. Tests await the work.
   */
  schedule(work: () => Promise<void>): void;
}

export interface TrackerRuleRepoEventInput {
  deliveryId: string;
  /** The stored event row, checked with `isTrackerSyncEvent` (invariant 4). */
  storedEvent: { event_type: string; metadata?: unknown; base_ref?: string | null; head_ref?: string | null };
  /** The room the event row is stored in (for counting approvals). */
  eventRoomId: string;
  roomEvent: RepoRoomEvent;
  /** The card the projection resolved, with its room. */
  task: Pick<Task, "id" | "room_id" | "external_ref" | "pr_url" | "workflow_artifacts">;
  /**
   * The resolver linked the event to the card by its ticket key (the key in
   * the branch, title or body, or a pull request the key linked before).
   * A lease, a hand-set `pr_url` or another artifact is not a confirmed link.
   */
  matchedByTicketKey: boolean;
}

export interface TrackerRuleRepoEventResult {
  /** Rules that matched and that this call recorded a run for. */
  runs: string[];
}

const NO_RUNS: TrackerRuleRepoEventResult = { runs: [] };
const RULE_EVENTS = new Set(["pull_request", "pull_request_review", "check_run"]);
/** GitHub `author_association` values of people with access to the repository. */
export const TRUSTED_AUTHOR_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"] as const;

function trustedAssociation(value: string | null | undefined): boolean {
  return typeof value === "string" && (TRUSTED_AUTHOR_ASSOCIATIONS as readonly string[]).includes(value.toUpperCase());
}

/** Pull requests in the repository itself that the check ran for (none for a fork's branch). */
function checkRunPullRequestNumbers(storedEvent: TrackerRuleRepoEventInput["storedEvent"]): number[] {
  const metadata = storedEvent.metadata as Record<string, unknown> | null | undefined;
  const numbers = metadata?.same_repo_pull_request_numbers;
  return Array.isArray(numbers) ? numbers.filter((number): number is number => typeof number === "number") : [];
}

/**
 * Whether the event reached the card through a confirmed link (ticket
 * connectors plan, PR5). A pull request or review counts when the resolver
 * matched it by the ticket key. A check run has no key of its own: it counts
 * when it ran for a pull request that the key linked to the card. PR6 adds a
 * human-confirmed Jev link here.
 */
export function eventLinkIsConfirmed(input: Pick<TrackerRuleRepoEventInput, "roomEvent" | "storedEvent" | "task" | "matchedByTicketKey">): boolean {
  const event = input.roomEvent;
  if (event.kind === "pull_request" || event.kind === "pull_request_review") return input.matchedByTicketKey;
  if (event.kind !== "check_run") return false;
  const numbers = new Set(checkRunPullRequestNumbers(input.storedEvent));
  return input.task.workflow_artifacts.some((artifact) => artifact.kind === "pull_request"
    && artifact.linked_by === "ticket_key"
    && typeof artifact.number === "number" && numbers.has(artifact.number)
    && repositoryPullRequestUrl(artifact.url, event.repositoryFullName) !== null);
}

/**
 * Whether someone with access to the repository caused the event. A pull
 * request from an outside author (a fork) fires a rule only when it merges,
 * which needs write access; a review counts only from a member; a check run
 * only for a branch in the repository itself (GitHub lists no pull request
 * for a fork's branch). Anyone can open a pull request on a public repo and
 * name a ticket key, so without this an outsider could move tickets.
 */
export function repoEventIsTrusted(event: RepoRoomEvent, storedEvent: TrackerRuleRepoEventInput["storedEvent"]): boolean {
  if (event.kind === "pull_request") {
    return trustedAssociation(event.pullRequest.authorAssociation)
      || (event.action === "closed" && event.pullRequest.merged === true);
  }
  if (event.kind === "pull_request_review") return trustedAssociation(event.review.authorAssociation);
  if (event.kind === "check_run") return checkRunPullRequestNumbers(storedEvent).length > 0;
  return false;
}

/** The matcher's facts for a repo event, or null for an event no rule can name. */
export function trackerRuleFacts(
  event: RepoRoomEvent,
  storedEvent: TrackerRuleRepoEventInput["storedEvent"],
  approvals: number | null,
): TrackerRuleEventFacts | null {
  if (event.kind === "pull_request") {
    return {
      event: "pull_request",
      action: event.action,
      merged: event.pullRequest.merged === true,
      draft: event.pullRequest.draft === true,
      baseBranch: storedEvent.base_ref ?? null,
    };
  }
  if (event.kind === "pull_request_review") {
    return {
      event: "pull_request_review",
      action: event.action,
      baseBranch: storedEvent.base_ref ?? null,
      reviewState: event.review.state,
      approvals,
    };
  }
  if (event.kind === "check_run") {
    return { event: "check_run", action: event.action, conclusion: event.checkRun.conclusion };
  }
  return null;
}

function pullRequestNumberFromUrl(url: string | null | undefined): number | null {
  const match = url?.match(/\/pull\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * A pull request URL of the event's own repository, or null. The card's
 * `pr_url` can be written by room members, so it is used only in this exact
 * shape, which holds no Markdown characters.
 */
export function repositoryPullRequestUrl(url: string | null | undefined, repositoryFullName: string): string | null {
  const match = url?.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d{1,10})$/);
  return match && match[1]!.toLowerCase() === repositoryFullName.toLowerCase() ? url! : null;
}

export function trackerRuleTemplateValues(
  event: RepoRoomEvent,
  storedEvent: TrackerRuleRepoEventInput["storedEvent"],
  task: TrackerRuleRepoEventInput["task"],
): TrackerRuleTemplateValues {
  const pullRequest = event.kind === "pull_request" || event.kind === "pull_request_review" ? event.pullRequest : null;
  const prUrl = repositoryPullRequestUrl(pullRequest?.url ?? task.pr_url, event.repositoryFullName);
  return {
    pr_url: prUrl,
    pr_number: pullRequest?.number ?? pullRequestNumberFromUrl(prUrl),
    pr_title: pullRequest?.title ?? null,
    author: pullRequest?.authorLogin ?? null,
    branch: pullRequest?.headRef ?? storedEvent.head_ref ?? null,
    base_branch: storedEvent.base_ref ?? null,
    repo: event.repositoryFullName,
    reviewer: event.kind === "pull_request_review" ? event.senderLogin ?? null : null,
  };
}

export function planTrackerRuleActions(
  rule: LoadedTrackerRule,
  values: TrackerRuleTemplateValues,
  provider: TrackerProvider,
): PlannedTrackerAction[] {
  return rule.actions.map((action) => action.kind === "transition"
    ? { kind: "tracker_transition", to_status: action.toStatus }
    : { kind: "tracker_comment", body: renderTrackerRuleTemplate(action.template, values, provider) });
}

/** The journal idempotency key of one action: rule, delivery, ticket and action index. */
export function trackerRuleEffectKey(ruleId: string, deliveryId: string, externalRef: string, index: number): string {
  return `${ruleId}:${deliveryId}:${externalRef}:${index}`;
}

/** A journal row that will not change any more without a person: no attempts left, or held. */
function isTerminalFailure(effect: WorkflowEffect): boolean {
  return Boolean(effect.quarantined_at) || (effect.state === "failed" && effect.attempt_count >= effect.max_attempts);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown error").slice(0, 500);
}

function isPlannedAction(value: unknown): value is PlannedTrackerAction {
  const entry = value as Record<string, unknown> | null;
  return Boolean(entry) && ((entry!.kind === "tracker_transition" && typeof entry!.to_status === "string")
    || (entry!.kind === "tracker_comment" && typeof entry!.body === "string"));
}

export function createTrackerRuleEngine(deps: TrackerRuleEngineDeps) {
  function trackerInput(run: TrackerRuleRunRow, index: number, connection: RoomRuleConnection): SubmitTrackerEffectInput | null {
    const planned = (run.planned_actions as unknown[])[index];
    const ref = parseExternalRef(run.external_ref);
    if (!isPlannedAction(planned) || !ref || !run.rule_id) return null;
    return {
      room_id: run.room_id,
      task_id: run.task_id,
      connection_id: connection.connection_id,
      connection_account_id: connection.account_id,
      provider: connection.provider,
      key: ref.key,
      idempotency_key: trackerRuleEffectKey(run.rule_id, run.delivery_id, run.external_ref, index),
      actor_label: `rule:${run.rule_name}`.slice(0, 200),
      action: planned.kind === "tracker_transition"
        ? { kind: "tracker_transition", to_status: planned.to_status }
        : { kind: "tracker_comment", body: planned.body },
    };
  }

  /** Reserves action `index` of the run and records its journal row on the run. */
  async function reserveAction(run: TrackerRuleRunRow, index: number, connection: RoomRuleConnection): Promise<ReserveResult | null> {
    const request = trackerInput(run, index, connection);
    if (!request) return null;
    const reserved = await deps.reserve(request);
    await deps.store.appendEffect(run.id, index, reserved.effect.id);
    return reserved;
  }

  /**
   * Moves a pending run forward: runs the reserved action it was handed,
   * then reserves and runs each next action only after the one before it
   * succeeded. An action that failed but may still be retried, or whose
   * outcome is unknown, is left to the journal sweep; `advancePendingRuns`
   * continues the run once it settles. A failure with no attempts left ends
   * the run, and the later actions are never reserved.
   */
  async function advance(runId: string, connection: RoomRuleConnection | null, first?: ReserveResult): Promise<void> {
    let reserved = first;
    for (let step = 0; step <= TRACKER_RULE_MAX_ACTIONS; step += 1) {
      if (reserved) await deps.drive(reserved);
      reserved = undefined;
      const run = await deps.store.getRun(runId);
      if (!run || run.outcome !== "pending") return;
      const effectIds = Array.isArray(run.effect_ids) ? run.effect_ids : [];
      if (effectIds.length > 0) {
        const last = await deps.getEffect(effectIds[effectIds.length - 1]!);
        if (!last) {
          await deps.store.finishRun(run.id, { outcome: "error", detail: "journal_row_missing" });
          return;
        }
        if (isTerminalFailure(last)) {
          await deps.store.finishRun(run.id, { outcome: last.quarantined_at ? "quarantined" : "failed", detail: null });
          return;
        }
        if (last.state !== "succeeded") return;
      }
      const planned = Array.isArray(run.planned_actions) ? run.planned_actions : [];
      if (effectIds.length >= planned.length) {
        await deps.store.finishRun(run.id, { outcome: "succeeded", detail: null });
        return;
      }
      const owner = connection ?? await deps.roomConnection(run.room_id, providerOf(run));
      if (!owner || owner.connection_id !== run.connection_id) {
        await deps.store.finishRun(run.id, { outcome: "error", detail: "connection_unavailable" });
        return;
      }
      try {
        reserved = await reserveAction(run, effectIds.length, owner) ?? undefined;
      } catch (error) {
        console.warn("[ticket-connectors] a tracker rule write was not reserved:", errorText(error));
        reserved = undefined;
      }
      if (!reserved) {
        await deps.store.finishRun(run.id, { outcome: "error", detail: "reservation_failed" });
        return;
      }
    }
  }

  return {
    /**
     * Runs the connection's rules for a repo event the projection resolved to
     * a card with a ticket. Never throws: a rule must not fail the webhook.
     */
    async runForRepoEvent(input: TrackerRuleRepoEventInput): Promise<TrackerRuleRepoEventResult> {
      // Invariant 4: a tracker sync event never reaches the matcher, so a
      // rule's own write cannot fire a rule.
      if (isTrackerSyncEvent(input.storedEvent) || !RULE_EVENTS.has(input.roomEvent.kind)) return NO_RUNS;
      const ref = input.task.external_ref ? parseExternalRef(input.task.external_ref) : null;
      if (!ref || (ref.provider !== "jira" && ref.provider !== "linear")) return NO_RUNS;
      // A lease, a hand-set pr_url or any other link is not enough to write to the tracker.
      if (!eventLinkIsConfirmed(input)) return NO_RUNS;
      const provider = ref.provider as TrackerProvider;
      try {
        const scope = await deps.roomScope(input.task.room_id);
        if (!scope.sources.some((source) => source.provider === provider)) return NO_RUNS;
        const connection = await deps.roomConnection(input.task.room_id, provider);
        if (!connection) return NO_RUNS;
        const rules = await deps.store.forRoom(connection.connection_id, input.task.room_id);
        if (rules.length === 0) return NO_RUNS;
        if (!await deps.ticketBound({ connectionId: connection.connection_id, roomId: input.task.room_id, taskId: input.task.id, key: ref.key })) {
          return NO_RUNS;
        }

        const event = input.roomEvent;
        const approvals = event.kind === "pull_request_review" && rulesNeedApprovalCount(rules)
          ? await deps.countApprovals({
              roomIds: [...new Set([input.eventRoomId, input.task.room_id])],
              pullNumber: event.pullRequest.number,
              pullUrl: event.pullRequest.url,
            })
          : null;
        const facts = trackerRuleFacts(event, input.storedEvent, approvals);
        if (!facts) return NO_RUNS;
        const matched = matchTrackerRules(rules, facts);
        if (matched.length === 0) return NO_RUNS;

        // A rule that matched but will not write is still recorded, so the
        // owner can see why it did not move the ticket.
        const skipReason: TrackerRuleSkipReason | undefined = !repoEventIsTrusted(event, input.storedEvent)
          ? "untrusted_actor"
          : !await deps.ownerIsRoomAdmin(input.task.room_id, connection.account_id) ? "owner_not_admin" : undefined;

        const values = skipReason ? null : trackerRuleTemplateValues(event, input.storedEvent, input.task);
        const eventUrl = event.kind === "check_run" ? event.checkRun.url
          : event.kind === "pull_request_review" ? event.review.url
          : event.kind === "pull_request" ? event.pullRequest.url
          : null;
        const runs: string[] = [];
        for (const rule of matched) {
          const { run, claimed } = await deps.store.claimRun({
            rule_id: rule.id,
            rule_version: rule.version,
            rule_name: rule.name,
            connection_id: connection.connection_id,
            room_id: input.task.room_id,
            task_id: input.task.id,
            external_ref: ref.ref,
            delivery_id: input.deliveryId,
            event_type: event.kind,
            event_action: event.action,
            event_url: eventUrl ?? null,
            planned_actions: values ? planTrackerRuleActions(rule, values, provider) as unknown as Array<Record<string, unknown>> : [],
          }, { skipReason });
          // Skipped, debounced, or another room already ran this rule for this
          // delivery and ticket (one write per event).
          if (!claimed || !run || run.outcome !== "pending") continue;
          runs.push(run.id);
          const effectIds = Array.isArray(run.effect_ids) ? run.effect_ids : [];
          if (effectIds.length > 0) {
            // A retry of the same delivery: continue where the run stands.
            deps.schedule(() => advance(run.id, connection));
            continue;
          }
          // The first journal row exists before the webhook answers.
          let first: ReserveResult | null = null;
          try {
            first = await reserveAction(run, 0, connection);
          } catch (error) {
            console.warn("[ticket-connectors] a tracker rule write was not reserved:", errorText(error));
          }
          if (!first) {
            await deps.store.finishRun(run.id, { outcome: "error", detail: "reservation_failed" });
            continue;
          }
          deps.schedule(() => advance(run.id, connection, first!));
        }
        return { runs };
      } catch (error) {
        console.warn("[ticket-connectors] tracker rules failed for a repo event:", errorText(error));
        return NO_RUNS;
      }
    },

    /**
     * Continues pending runs after the journal sweep: a run whose last action
     * settled reserves its next one, and a run left with no journal row (the
     * process stopped right after the claim) reserves its first.
     */
    async advancePendingRuns(limit = 50): Promise<number> {
      const ids = await deps.store.pendingRuns(limit);
      for (const id of ids) {
        try {
          await advance(id, null);
        } catch (error) {
          console.warn("[ticket-connectors] a pending tracker rule run could not continue:", errorText(error));
        }
      }
      return ids.length;
    },
  };
}

function providerOf(run: TrackerRuleRunRow): TrackerProvider {
  return (parseExternalRef(run.external_ref)?.provider ?? "jira") as TrackerProvider;
}

/** The room's filter for one tracker, joined to its connection; the filter's author must own the connection. */
export async function findRoomRuleConnection(roomId: string, provider: TrackerProvider): Promise<RoomRuleConnection | null> {
  const [row] = await db.select({
    connection_id: tracker_connections.id,
    account_id: tracker_connections.account_id,
  }).from(room_tracker_filters)
    .innerJoin(tracker_connections, eq(tracker_connections.id, room_tracker_filters.connection_id))
    .where(and(
      eq(room_tracker_filters.room_id, roomId),
      eq(room_tracker_filters.provider, provider),
      eq(room_tracker_filters.enabled, true),
      eq(tracker_connections.provider, provider),
      eq(tracker_connections.status, "active"),
      eq(room_tracker_filters.created_by_account_id, tracker_connections.account_id),
    ))
    .limit(1);
  return row ? { ...row, provider } : null;
}

/** An admin of the room, or of the repository room it belongs to, as the room routes decide it. */
export async function isRoomAdminAccount(roomId: string, accountId: string): Promise<boolean> {
  const { getProjectById, isProjectAdmin } = await import("../../db.js");
  const { getProjectAccessRoomId } = await import("../../rooms/access.js");
  if (await isProjectAdmin(roomId, accountId)) return true;
  const project = await getProjectById(roomId);
  const accessRoomId = project ? getProjectAccessRoomId(project) : roomId;
  return accessRoomId !== roomId && await isProjectAdmin(accessRoomId, accountId);
}

/** The card's `external_item_id` names this connection's cached item for the key. */
export async function isTicketBoundToConnection(input: { connectionId: string; roomId: string; taskId: string; key: string }): Promise<boolean> {
  const number = parseScopedId(input.taskId, "task");
  if (number === null) return false;
  const [row] = await db.select({ id: external_items.id }).from(tasks)
    .innerJoin(external_items, eq(external_items.id, tasks.external_item_id))
    .where(and(
      eq(tasks.room_id, input.roomId),
      eq(tasks.number, number),
      eq(external_items.connection_id, input.connectionId),
      eq(external_items.key, input.key),
    ))
    .limit(1);
  return Boolean(row);
}

/**
 * Reviewers with access to the repository whose latest submitted or
 * dismissed review of the pull request approves it, from the review events
 * stored in the given rooms. Comment-only reviews do not change a reviewer's
 * verdict, as on GitHub.
 */
export async function countPullRequestApprovals(input: { roomIds: string[]; pullNumber: number; pullUrl: string }): Promise<number> {
  if (input.roomIds.length === 0) return 0;
  const escaped = input.pullUrl.replace(/[\\%_]/g, (char) => `\\${char}`);
  const rows = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM (
      SELECT DISTINCT ON (lower(${github_room_events.actor_login})) ${github_room_events.state} AS state
      FROM ${github_room_events}
      WHERE ${inArray(github_room_events.room_id, input.roomIds)}
        AND ${github_room_events.event_type} = 'pull_request_review'
        AND ${github_room_events.github_object_id} = ${String(input.pullNumber)}
        AND ${like(github_room_events.github_object_url, `${escaped}#%`)}
        AND ${github_room_events.actor_login} IS NOT NULL
        AND lower(coalesce(${github_room_events.state}, '')) <> 'commented'
        AND upper(coalesce(${github_room_events.metadata}->>'reviewer_association', '')) IN ('OWNER', 'MEMBER', 'COLLABORATOR')
      ORDER BY lower(${github_room_events.actor_login}), ${github_room_events.event_order_at} DESC, ${github_room_events.created_at} DESC
    ) latest
    WHERE lower(latest.state) = 'approved'
  `);
  return Number(rows.rows[0]?.count ?? 0);
}

let defaultEngine: ReturnType<typeof createTrackerRuleEngine> | null = null;

/** The engine on the server's database and broker. Imported lazily so tests can run without a broker. */
export async function getDefaultTrackerRuleEngine(): Promise<ReturnType<typeof createTrackerRuleEngine>> {
  if (defaultEngine) return defaultEngine;
  const { workflowEffectBroker } = await import("../../workflow-effects/runtime.js");
  defaultEngine = createTrackerRuleEngine({
    store: trackerRuleStore,
    roomScope: getCachedRoomTrackerScope,
    roomConnection: findRoomRuleConnection,
    ticketBound: isTicketBoundToConnection,
    ownerIsRoomAdmin: isRoomAdminAccount,
    countApprovals: countPullRequestApprovals,
    reserve: (input) => workflowEffectBroker.reserveTrackerEffect(input),
    drive: (reserved) => workflowEffectBroker.driveTrackerEffect(reserved),
    getEffect: (id) => workflowEffectBroker.getEffect(id),
    schedule: (work) => {
      void work().catch((error) => console.warn("[ticket-connectors] tracker rule write failed:", errorText(error)));
    },
  });
  return defaultEngine;
}
