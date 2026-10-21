import { and, eq, like, sql } from "drizzle-orm";

import { isTrackerSyncEvent, type TrackerProvider } from "../../../../shared/ticket-connectors.mjs";
import { db } from "../../db/client.js";
import { github_room_events, room_tracker_filters, tracker_connections } from "../../db/schema.js";
import type { Task } from "../../db/types.js";
import type { WorkflowEffect } from "../../db/types/effects.js";
import type { RepoRoomEvent } from "../../repo-workflow/types.js";
import type { SubmitTrackerEffectInput } from "../../workflow-effects/broker.js";
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
  /** Reviewers whose latest review of the pull request approves it. */
  countApprovals(input: { roomId: string; pullNumber: number; pullUrl: string }): Promise<number>;
  /** The broker's `submitTrackerEffect`: every tracker write goes through the journal (invariant 3). */
  submit(input: SubmitTrackerEffectInput): Promise<WorkflowEffect>;
  /**
   * Runs the tracker writes after the webhook answers: a tracker call can take
   * up to 15 s. A write that a crash interrupts stays in the journal as
   * pending and is reconciled by the sweep. Tests await the work.
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
  const match = url?.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return match ? Number(match[1]) : null;
}

export function trackerRuleTemplateValues(
  event: RepoRoomEvent,
  storedEvent: TrackerRuleRepoEventInput["storedEvent"],
  task: TrackerRuleRepoEventInput["task"],
): TrackerRuleTemplateValues {
  const pullRequest = event.kind === "pull_request" || event.kind === "pull_request_review" ? event.pullRequest : null;
  const prUrl = pullRequest?.url ?? task.pr_url ?? null;
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
  if (effects.every((effect) => effect.state === "succeeded")) return "succeeded";
  return "pending";
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : "The tracker write could not be reserved.").slice(0, 500);
}

function isPlannedAction(value: unknown): value is PlannedTrackerAction {
  const entry = value as Record<string, unknown> | null;
  return Boolean(entry) && ((entry!.kind === "tracker_transition" && typeof entry!.to_status === "string")
    || (entry!.kind === "tracker_comment" && typeof entry!.body === "string"));
}

export function createTrackerRuleEngine(deps: TrackerRuleEngineDeps) {
  async function drive(input: {
    runId: string;
    rule: LoadedTrackerRule;
    connection: RoomRuleConnection;
    key: string;
    deliveryId: string;
    task: TrackerRuleRepoEventInput["task"];
    planned: PlannedTrackerAction[];
  }): Promise<void> {
    const effects: WorkflowEffect[] = [];
    let detail: string | null = null;
    for (const [index, action] of input.planned.entries()) {
      try {
        effects.push(await deps.submit({
          room_id: input.task.room_id,
          task_id: input.task.id,
          connection_id: input.connection.connection_id,
          connection_account_id: input.connection.account_id,
          provider: input.connection.provider,
          key: input.key,
          idempotency_key: trackerRuleEffectKey(input.rule.id, input.deliveryId, index),
          actor_label: `rule:${input.rule.name}`.slice(0, 200),
          action: action.kind === "tracker_transition"
            ? { kind: "tracker_transition", to_status: action.to_status }
            : { kind: "tracker_comment", body: action.body },
        }));
      } catch (error) {
        // A removed connection or a changed request: stop, so a later action
        // never runs without the ones before it.
        detail = errorText(error);
        break;
      }
    }
    const lastError = effects.map((effect) => effect.last_error).find(Boolean) ?? null;
    await deps.store.finishRun(input.runId, {
      effect_ids: effects.map((effect) => effect.id),
      outcome: detail ? "error" : outcomeOf(effects),
      detail: detail ?? effects.find((effect) => effect.quarantine_reason)?.quarantine_reason ?? lastError,
    });
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
        const approvals = event.kind === "pull_request_review" && rulesNeedApprovalCount(rules)
          ? await deps.countApprovals({ roomId: input.eventRoomId, pullNumber: event.pullRequest.number, pullUrl: event.pullRequest.url })
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
          // Another room already ran this rule for this delivery: one write per event.
          if (!claimed) continue;
          runs.push(run.id);
          // A retry of the same delivery submits what the first attempt planned.
          const planned = (run.planned_actions as unknown[]).filter(isPlannedAction);
          deps.schedule(() => drive({ runId: run.id, rule, connection, key: ref.key, deliveryId: input.deliveryId, task: input.task, planned }));
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

/**
 * Reviewers whose latest submitted or dismissed review of the pull request
 * approves it, from the review events stored in the room. Comment-only
 * reviews do not change a reviewer's verdict, as on GitHub.
 */
export async function countPullRequestApprovals(input: { roomId: string; pullNumber: number; pullUrl: string }): Promise<number> {
  const escaped = input.pullUrl.replace(/[\\%_]/g, (char) => `\\${char}`);
  const rows = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM (
      SELECT DISTINCT ON (lower(${github_room_events.actor_login})) ${github_room_events.state} AS state
      FROM ${github_room_events}
      WHERE ${github_room_events.room_id} = ${input.roomId}
        AND ${github_room_events.event_type} = 'pull_request_review'
        AND ${github_room_events.github_object_id} = ${String(input.pullNumber)}
        AND ${like(github_room_events.github_object_url, `${escaped}#%`)}
        AND ${github_room_events.actor_login} IS NOT NULL
        AND lower(coalesce(${github_room_events.state}, '')) <> 'commented'
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
    countApprovals: countPullRequestApprovals,
    submit: (input) => workflowEffectBroker.submitTrackerEffect(input),
    schedule: (work) => {
      void work().catch((error) => console.warn("[ticket-connectors] tracker rule write failed:", errorText(error)));
    },
  });
  return defaultEngine;
}
