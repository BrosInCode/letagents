import { and, eq, inArray, like, sql } from "drizzle-orm";

import { isTrackerSyncEvent, type TrackerProvider } from "../../../../shared/ticket-connectors.mjs";
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
import { trackerRuleStore, type LoadedTrackerRule, type TrackerRuleRunOutcome, type TrackerRuleStore } from "./store.js";
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
  store: Pick<TrackerRuleStore, "forRoom" | "claimRun" | "finishRun">;
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
  /** Reviewers from the repository whose latest review of the pull request approves it. */
  countApprovals(input: { roomIds: string[]; pullNumber: number; pullUrl: string }): Promise<number>;
  /** The broker's `reserveTrackerEffect`: every tracker write goes through the journal (invariant 3). */
  reserve(input: SubmitTrackerEffectInput): Promise<ReserveResult>;
  /** The broker's `driveTrackerEffect`. */
  drive(reserved: ReserveResult): Promise<WorkflowEffect>;
  /** The broker's `abandonTrackerEffect`: a reserved write that will not run fails before any tracker call. */
  abandon(reserved: ReserveResult, reason: string): Promise<WorkflowEffect>;
  getEffect(id: string): Promise<WorkflowEffect | null>;
  /**
   * Runs the tracker calls after the webhook answers: one can take up to
   * 15 s. The journal rows are reserved before, so a crash in between leaves
   * pending rows that the sweep reconciles. Tests await the work.
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
  task: Pick<Task, "id" | "room_id" | "external_ref" | "pr_url">;
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

function metadataNumber(storedEvent: TrackerRuleRepoEventInput["storedEvent"], key: string): number {
  const metadata = storedEvent.metadata as Record<string, unknown> | null | undefined;
  const value = metadata?.[key];
  return typeof value === "number" ? value : 0;
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
  if (event.kind === "check_run") return metadataNumber(storedEvent, "same_repo_pull_request_count") > 0;
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

export function trackerRuleEffectKey(ruleId: string, deliveryId: string, index: number): string {
  return `${ruleId}:${deliveryId}:${index}`;
}

function outcomeOf(effects: WorkflowEffect[]): TrackerRuleRunOutcome {
  if (effects.some((effect) => effect.quarantined_at)) return "quarantined";
  if (effects.some((effect) => effect.state === "failed")) return "failed";
  if (effects.length > 0 && effects.every((effect) => effect.state === "succeeded")) return "succeeded";
  return "pending";
}

/**
 * Fixed audit text. Every room member sees the audit, so provider error text
 * (which can name another project's statuses) stays in the journal row.
 */
const OUTCOME_DETAIL: Record<TrackerRuleRunOutcome, string | null> = {
  succeeded: null,
  pending: "The tracker write is still being confirmed.",
  failed: "The tracker refused the write. The connection owner can see why in the connection's settings.",
  quarantined: "The write was held: the comment was empty or too long.",
  error: "The write could not be reserved: the connection was removed or changed.",
};

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown error").slice(0, 500);
}

function isPlannedAction(value: unknown): value is PlannedTrackerAction {
  const entry = value as Record<string, unknown> | null;
  return Boolean(entry) && ((entry!.kind === "tracker_transition" && typeof entry!.to_status === "string")
    || (entry!.kind === "tracker_comment" && typeof entry!.body === "string"));
}

export function createTrackerRuleEngine(deps: TrackerRuleEngineDeps) {
  /** The run's outcome from the journal rows as they are now, so a late writer never shows an older state. */
  async function settle(runId: string, effectIds: string[], failed: boolean): Promise<void> {
    const effects = (await Promise.all(effectIds.map((id) => deps.getEffect(id))))
      .filter((effect): effect is WorkflowEffect => effect !== null);
    const outcome: TrackerRuleRunOutcome = failed ? "error" : outcomeOf(effects);
    await deps.store.finishRun(runId, { effect_ids: effectIds, outcome, detail: OUTCOME_DETAIL[outcome] });
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
      const provider = ref.provider as TrackerProvider;
      try {
        const scope = await deps.roomScope(input.task.room_id);
        if (!scope.sources.some((source) => source.provider === provider)) return NO_RUNS;
        const connection = await deps.roomConnection(input.task.room_id, provider);
        if (!connection) return NO_RUNS;
        const rules = await deps.store.forRoom(connection.connection_id, input.task.room_id);
        if (rules.length === 0) return NO_RUNS;
        const event = input.roomEvent;
        if (!repoEventIsTrusted(event, input.storedEvent)) return NO_RUNS;
        if (!await deps.ticketBound({ connectionId: connection.connection_id, roomId: input.task.room_id, taskId: input.task.id, key: ref.key })) {
          return NO_RUNS;
        }

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

        const values = trackerRuleTemplateValues(event, input.storedEvent, input.task);
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
            planned_actions: planTrackerRuleActions(rule, values, provider) as unknown as Array<Record<string, unknown>>,
          });
          // Another room already ran this rule for this delivery (one write per
          // event), or it ran for this ticket and event moments ago.
          if (!claimed || !run) continue;
          runs.push(run.id);

          // Reserve every journal row before the webhook answers. A retry of
          // the same delivery submits what the first attempt planned and gets
          // the same rows back.
          const planned = (run.planned_actions as unknown[]).filter(isPlannedAction);
          const reserved: ReserveResult[] = [];
          let failed = false;
          for (const [index, action] of planned.entries()) {
            try {
              reserved.push(await deps.reserve({
                room_id: input.task.room_id,
                task_id: input.task.id,
                connection_id: connection.connection_id,
                connection_account_id: connection.account_id,
                provider,
                key: ref.key,
                idempotency_key: trackerRuleEffectKey(rule.id, input.deliveryId, index),
                actor_label: `rule:${rule.name}`.slice(0, 200),
                action: action.kind === "tracker_transition"
                  ? { kind: "tracker_transition", to_status: action.to_status }
                  : { kind: "tracker_comment", body: action.body },
              }));
            } catch (error) {
              // A removed connection or a changed request: stop, so a later
              // action never runs without the ones before it.
              console.warn("[ticket-connectors] a tracker rule write was not reserved:", errorText(error));
              failed = true;
              break;
            }
          }
          const effectIds = reserved.map((entry) => entry.effect.id);
          await deps.store.finishRun(run.id, {
            effect_ids: effectIds,
            outcome: failed ? "error" : "pending",
            detail: OUTCOME_DETAIL[failed ? "error" : "pending"],
          });
          if (failed) {
            // A later reservation failed: run none of this rule's writes.
            for (const entry of reserved) await deps.abandon(entry, "A later action of this rule could not be reserved; none was run.");
            await settle(run.id, effectIds, true);
            continue;
          }
          deps.schedule(async () => {
            // In order. After a write that did not succeed, the later ones are
            // failed for good before any tracker call, so the journal sweep
            // never runs a later action without the ones before it.
            let stopped = false;
            for (const entry of reserved) {
              if (stopped) {
                await deps.abandon(entry, "An earlier action of this rule did not succeed; this one was not run.");
                continue;
              }
              const effect = await deps.drive(entry);
              if (effect.state !== "succeeded") stopped = true;
            }
            await settle(run.id, effectIds, failed);
          });
        }
        return { runs };
      } catch (error) {
        console.warn("[ticket-connectors] tracker rules failed for a repo event:", errorText(error));
        return NO_RUNS;
      }
    },
  };
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
    countApprovals: countPullRequestApprovals,
    reserve: (input) => workflowEffectBroker.reserveTrackerEffect(input),
    drive: (reserved) => workflowEffectBroker.driveTrackerEffect(reserved),
    abandon: (reserved, reason) => workflowEffectBroker.abandonTrackerEffect(reserved, reason),
    getEffect: (id) => workflowEffectBroker.getEffect(id),
    schedule: (work) => {
      void work().catch((error) => console.warn("[ticket-connectors] tracker rule write failed:", errorText(error)));
    },
  });
  return defaultEngine;
}
