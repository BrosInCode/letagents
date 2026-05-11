/**
 * Continuity Pack builder — Tier 1 deterministic half (p1.6).
 *
 * Spec §8.5: when a rental session uses Smart Handoff, the server
 * generates a Continuity Pack so the rented agent can pick up the
 * previous agent's work without rebuilding context from scratch.
 *
 * V1 generates the pack as a hybrid:
 *   Tier 1 (this module):  deterministic fields lifted from the
 *                          session row + activity event ledger
 *                          (files touched, commands run, test
 *                          results, active diff, session metadata).
 *   Tier 2 (later, p4.6):  model-generated narrative (what was
 *                          being attempted, where the agent got
 *                          stuck, likely next step).
 *
 * The Tier 1 half is the safety net. The model-generated half
 * improves flow but must NOT be the only source of truth. This
 * module is the pure deterministic builder: takes a snapshot of
 * the relevant session row + activity events and returns a
 * canonicalized, hash-stable pack.
 *
 * Cap rules (per §8.5):
 *   • Up to 20 touched / exposed files; older entries collapsed
 *     into "and N more".
 *   • Up to 10 recent commands; prioritized by status (failed
 *     or renter-approved beat plain "run" events).
 *   • Latest active diff only — no historical intermediate diffs.
 *
 * Spec refs:
 *   §8.5  Continuity Pack content + V1 caps
 *   §9.4  activity event taxonomy (source of the deterministic
 *         half — file_exposed, command_run, command_timed_out,
 *         edit_proposed, patch_proposed, patch_gate.tests_failed)
 *   §19.2 rental_sessions.continuity_pack jsonb column
 *
 * Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p1.6 (deterministic
 * half only; Tier 2 narrative lands in p4.6).
 */

import { createHash } from "node:crypto";

import {
  COMMAND_BLOCKED,
  COMMAND_OUTPUT,
  COMMAND_RUN,
  COMMAND_TIMED_OUT,
  CONTEXT_FILE_EXPOSED,
  EDIT_PROPOSED,
  PATCH_GATE_TESTS_FAILED,
  PATCH_PROPOSED,
  type RentalActivityEventType,
} from "./activity-event-types.js";

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

export const CONTINUITY_FILE_CAP = 20;
export const CONTINUITY_COMMAND_CAP = 10;

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/**
 * Minimal rental-session shape the Continuity Pack reads. Mirrors
 * the columns the deterministic half cares about so the function
 * is trivially mockable in tests.
 */
export interface ContinuityPackSession {
  id: string;
  task_title: string;
  task_prompt: string;
  base_branch: string;
  work_branch: string | null;
  status: string;
  mode: string;
  approved_scope: unknown;
  policy: unknown;
}

/**
 * Activity event shape we read. A subset of `rental_activity_events`.
 */
export interface ContinuityPackEvent {
  id: string;
  event_type: RentalActivityEventType | string;
  source: string;
  payload: unknown;
  created_at: Date | string;
}

export interface ContinuityFileEntry {
  path: string;
  reason: string;
  lastTouchedAt: string;
  source: string;
  /**
   * Whether the file appeared via an explicit `context.file_exposed`
   * (renter-approved) event. Files exposed by a tool action with
   * pre-approved scope are still flagged via this field for the
   * model-generated half to highlight scope choices.
   */
  scopeApproved: boolean;
}

export interface ContinuityCommandEntry {
  command: string;
  ranAt: string;
  outcome: "run" | "timed_out" | "blocked";
  exitCode: number | null;
  source: string;
}

export interface ContinuityFailingTestEntry {
  test: string;
  failedAt: string;
  details: string | null;
}

export interface ContinuityActiveDiff {
  patchId: string | null;
  proposedAt: string;
  source: string;
  summary: string | null;
  diffRef: string | null;
  diffPreview: string | null;
}

export interface ContinuityPack {
  /** Stable hash over the canonicalized contents. */
  packId: string;
  schemaVersion: 1;
  tier: "tier1_deterministic";
  generatedAt: string;
  session: {
    id: string;
    taskTitle: string;
    taskPrompt: string;
    baseBranch: string;
    workBranch: string | null;
    status: string;
    mode: string;
  };
  approvedScope: unknown;
  policy: unknown;
  filesTouched: ContinuityFileEntry[];
  filesTouchedSummary: { totalCount: number; truncatedCount: number };
  commandsRun: ContinuityCommandEntry[];
  commandsRunSummary: { totalCount: number; truncatedCount: number };
  failingTests: ContinuityFailingTestEntry[];
  activeDiff: ContinuityActiveDiff | null;
}

export interface BuildContinuityPackOptions {
  /** Override clock for deterministic generatedAt in tests. */
  nowIso?: string;
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

/**
 * Build the deterministic half of the Continuity Pack from a
 * session row + a chronological list of activity events.
 *
 * Pure: no DB reads, no clock dependency when `nowIso` is provided.
 *
 * The events may be passed in any order. The function will:
 *   • sort files_touched by lastTouchedAt descending (newest first)
 *     then deduplicate by path so the most recent touch wins
 *   • sort commands by ranAt descending and PRIORITIZE
 *     non-`run` outcomes (blocked / timed_out) over plain runs
 *     when truncating
 *   • take only the most-recently-proposed patch (PATCH_PROPOSED
 *     or EDIT_PROPOSED) as the active diff
 *   • include every `patch_gate.tests_failed` event verbatim
 */
export function buildContinuityPack(
  session: ContinuityPackSession,
  events: ReadonlyArray<ContinuityPackEvent>,
  options: BuildContinuityPackOptions = {},
): ContinuityPack {
  const generatedAt = options.nowIso ?? new Date().toISOString();

  const files = collectFilesTouched(events);
  const commands = collectCommands(events);
  const failingTests = collectFailingTests(events);
  const activeDiff = collectActiveDiff(events);

  // Caps + summaries
  const fileTotal = files.length;
  const cappedFiles = files.slice(0, CONTINUITY_FILE_CAP);
  const filesTruncated = Math.max(0, fileTotal - CONTINUITY_FILE_CAP);

  const commandTotal = commands.length;
  const cappedCommands = commands.slice(0, CONTINUITY_COMMAND_CAP);
  const commandsTruncated = Math.max(0, commandTotal - CONTINUITY_COMMAND_CAP);

  const pack: ContinuityPack = {
    packId: "", // computed below
    schemaVersion: 1,
    tier: "tier1_deterministic",
    generatedAt,
    session: {
      id: session.id,
      taskTitle: session.task_title,
      taskPrompt: session.task_prompt,
      baseBranch: session.base_branch,
      workBranch: session.work_branch,
      status: session.status,
      mode: session.mode,
    },
    approvedScope: session.approved_scope ?? null,
    policy: session.policy ?? null,
    filesTouched: cappedFiles,
    filesTouchedSummary: {
      totalCount: fileTotal,
      truncatedCount: filesTruncated,
    },
    commandsRun: cappedCommands,
    commandsRunSummary: {
      totalCount: commandTotal,
      truncatedCount: commandsTruncated,
    },
    failingTests,
    activeDiff,
  };

  // packId is a stable hash of the SESSION + DETERMINISTIC CONTENT
  // only. We intentionally EXCLUDE generatedAt from the hash input
  // so two builds with identical inputs at different wall-clock
  // times produce the same packId. The DB writer can use this id
  // as an idempotency key on `rental_sessions.continuity_pack`.
  pack.packId = computePackId(pack);
  return pack;
}

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

export function computePackId(pack: ContinuityPack): string {
  // Canonicalize: strip generatedAt + the placeholder packId before
  // hashing so we get a stable id across builds.
  const canonical = {
    schemaVersion: pack.schemaVersion,
    tier: pack.tier,
    session: pack.session,
    approvedScope: pack.approvedScope,
    policy: pack.policy,
    filesTouched: pack.filesTouched,
    filesTouchedSummary: pack.filesTouchedSummary,
    commandsRun: pack.commandsRun,
    commandsRunSummary: pack.commandsRunSummary,
    failingTests: pack.failingTests,
    activeDiff: pack.activeDiff,
  };
  const serialized = JSON.stringify(canonical, replacerStable);
  const hex = createHash("sha256").update(serialized).digest("hex");
  return `cpack_${hex.slice(0, 32)}`;
}

function replacerStable(_key: string, value: unknown): unknown {
  // Sort plain-object keys so JSON.stringify produces a canonical
  // string regardless of insertion order. Arrays preserve order.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Files touched
// ---------------------------------------------------------------------------

function collectFilesTouched(
  events: ReadonlyArray<ContinuityPackEvent>,
): ContinuityFileEntry[] {
  const byPath = new Map<string, ContinuityFileEntry>();

  for (const ev of events) {
    const ts = isoTs(ev.created_at);
    const payload = asObject(ev.payload);
    if (!payload) continue;

    if (ev.event_type === CONTEXT_FILE_EXPOSED) {
      const path = typeof payload.path === "string" ? payload.path : null;
      if (!path) continue;
      const reason = typeof payload.reason === "string"
        ? payload.reason
        : "exposed";
      mergeFile(byPath, {
        path,
        reason,
        lastTouchedAt: ts,
        source: ev.source,
        scopeApproved: true,
      });
      continue;
    }

    if (ev.event_type === EDIT_PROPOSED || ev.event_type === PATCH_PROPOSED) {
      const raw = payload.files ?? payload.paths ?? [];
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        const path = typeof item === "string"
          ? item
          : typeof item === "object" && item !== null && typeof (item as { path?: unknown }).path === "string"
            ? (item as { path: string }).path
            : null;
        if (!path) continue;
        mergeFile(byPath, {
          path,
          reason: ev.event_type === PATCH_PROPOSED ? "patch_proposed" : "edit_proposed",
          lastTouchedAt: ts,
          source: ev.source,
          scopeApproved: false,
        });
      }
    }
  }

  return [...byPath.values()].sort((a, b) =>
    b.lastTouchedAt.localeCompare(a.lastTouchedAt),
  );
}

function mergeFile(
  byPath: Map<string, ContinuityFileEntry>,
  entry: ContinuityFileEntry,
): void {
  const existing = byPath.get(entry.path);
  if (!existing) {
    byPath.set(entry.path, entry);
    return;
  }
  if (entry.lastTouchedAt > existing.lastTouchedAt) {
    byPath.set(entry.path, {
      ...entry,
      // Preserve scopeApproved=true once granted.
      scopeApproved: existing.scopeApproved || entry.scopeApproved,
    });
  } else {
    existing.scopeApproved = existing.scopeApproved || entry.scopeApproved;
  }
}

// ---------------------------------------------------------------------------
// Commands run
// ---------------------------------------------------------------------------

function collectCommands(
  events: ReadonlyArray<ContinuityPackEvent>,
): ContinuityCommandEntry[] {
  const out: ContinuityCommandEntry[] = [];
  for (const ev of events) {
    if (
      ev.event_type !== COMMAND_RUN
      && ev.event_type !== COMMAND_TIMED_OUT
      && ev.event_type !== COMMAND_BLOCKED
      && ev.event_type !== COMMAND_OUTPUT
    ) continue;
    const payload = asObject(ev.payload);
    if (!payload) continue;
    const command = typeof payload.command === "string" ? payload.command : null;
    if (!command) continue;
    const outcome: ContinuityCommandEntry["outcome"] =
      ev.event_type === COMMAND_TIMED_OUT ? "timed_out"
      : ev.event_type === COMMAND_BLOCKED ? "blocked"
      : "run";
    const exitCode = typeof payload.exit_code === "number"
      ? payload.exit_code
      : typeof payload.exitCode === "number"
        ? payload.exitCode
        : null;
    out.push({
      command,
      ranAt: isoTs(ev.created_at),
      outcome,
      exitCode,
      source: ev.source,
    });
  }

  // Sort by recency descending, then prioritize non-`run` outcomes
  // so the truncation window keeps failed/blocked/timed_out commands
  // even when there are many trailing successful runs.
  return out.sort((a, b) => {
    const priorityDelta = outcomePriority(b.outcome) - outcomePriority(a.outcome);
    if (priorityDelta !== 0) return priorityDelta;
    return b.ranAt.localeCompare(a.ranAt);
  });
}

function outcomePriority(outcome: ContinuityCommandEntry["outcome"]): number {
  switch (outcome) {
    case "blocked": return 2;
    case "timed_out": return 2;
    case "run": return 1;
  }
}

// ---------------------------------------------------------------------------
// Failing tests
// ---------------------------------------------------------------------------

function collectFailingTests(
  events: ReadonlyArray<ContinuityPackEvent>,
): ContinuityFailingTestEntry[] {
  const out: ContinuityFailingTestEntry[] = [];
  for (const ev of events) {
    if (ev.event_type !== PATCH_GATE_TESTS_FAILED) continue;
    const payload = asObject(ev.payload);
    if (!payload) continue;
    const testsRaw = payload.tests ?? payload.failing_tests ?? [];
    if (!Array.isArray(testsRaw)) continue;
    for (const item of testsRaw) {
      if (typeof item === "string") {
        out.push({
          test: item,
          failedAt: isoTs(ev.created_at),
          details: null,
        });
        continue;
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const name = typeof obj.name === "string"
          ? obj.name
          : typeof obj.test === "string"
            ? obj.test
            : null;
        if (!name) continue;
        const details = typeof obj.details === "string" ? obj.details : null;
        out.push({
          test: name,
          failedAt: isoTs(ev.created_at),
          details,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Active diff (most recently proposed patch/edit)
// ---------------------------------------------------------------------------

function collectActiveDiff(
  events: ReadonlyArray<ContinuityPackEvent>,
): ContinuityActiveDiff | null {
  // Per §8.5: "Latest active diff only — no historical intermediate
  // diffs." Walk events; keep the most-recent patch/edit proposal.
  let active: ContinuityActiveDiff | null = null;
  for (const ev of events) {
    if (ev.event_type !== PATCH_PROPOSED && ev.event_type !== EDIT_PROPOSED) continue;
    const payload = asObject(ev.payload);
    if (!payload) continue;
    const candidate: ContinuityActiveDiff = {
      patchId: typeof payload.patch_id === "string"
        ? payload.patch_id
        : typeof payload.patchId === "string"
          ? payload.patchId
          : null,
      proposedAt: isoTs(ev.created_at),
      source: ev.source,
      summary: typeof payload.summary === "string" ? payload.summary : null,
      diffRef: typeof payload.diff_ref === "string"
        ? payload.diff_ref
        : typeof payload.diffRef === "string"
          ? payload.diffRef
          : null,
      diffPreview: typeof payload.diff_preview === "string"
        ? payload.diff_preview
        : typeof payload.diffPreview === "string"
          ? payload.diffPreview
          : null,
    };
    if (!active || candidate.proposedAt > active.proposedAt) {
      active = candidate;
    }
  }
  return active;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isoTs(value: Date | string): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date().toISOString();
}
