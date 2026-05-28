/**
 * Parse `GetAllCascadeTrajectories` JSON — shapes from Antigravity-Deck (`trajectorySummaries`
 * map) and Antigravity-Link (array aliases). Returns cascadeId → summary row.
 * @param {unknown} parsed
 * @returns {Map<string, { status: string, trajectoryId?: string, stepCount?: number, summary?: string }>}
 */
export function parseTrajectorySummaries(parsed) {
  const map = new Map();
  if (!parsed || typeof parsed !== "object") return map;
  const o = /** @type {Record<string, unknown>} */ (parsed);

  const ts = o.trajectorySummaries;
  if (ts && typeof ts === "object" && !Array.isArray(ts)) {
    for (const [cid, info] of Object.entries(ts)) {
      if (!info || typeof info !== "object") continue;
      const inf = /** @type {Record<string, unknown>} */ (info);
      map.set(cid, {
        status: String(inf.status ?? ""),
        trajectoryId:
          typeof inf.trajectoryId === "string" ? inf.trajectoryId : undefined,
        stepCount:
          typeof inf.stepCount === "number" ? inf.stepCount : undefined,
        summary: typeof inf.summary === "string" ? inf.summary : undefined,
      });
    }
    return map;
  }

  const arr = /** @type {unknown[]} */ (
    (Array.isArray(o.trajectories) && o.trajectories) ||
      (Array.isArray(o.cascade_trajectories) && o.cascade_trajectories) ||
      (Array.isArray(o.cascades) && o.cascades) ||
      []
  );
  for (const t of arr) {
    if (!t || typeof t !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (t);
    const cid = String(
      row.cascadeId ??
        row.cascade_id ??
        row.id ??
        row.trajectoryId ??
        "",
    ).trim();
    if (!cid) continue;
    map.set(cid, {
      status: String(row.status ?? row.state ?? ""),
      trajectoryId:
        typeof row.trajectoryId === "string" ? row.trajectoryId : undefined,
      stepCount:
        typeof row.stepCount === "number"
          ? row.stepCount
          : typeof row.numTotalSteps === "number"
            ? row.numTotalSteps
            : undefined,
      summary: typeof row.summary === "string" ? row.summary : undefined,
    });
  }
  return map;
}

/**
 * Prefer RUNNING / WAITING; else first key; else last key (Link-style fallback).
 * @param {Map<string, { status: string }>} map
 */
export function pickActiveCascadeIdFromMap(map) {
  const isActive = (s) => {
    const u = String(s).toUpperCase();
    return (
      u.includes("RUNNING") ||
      u.includes("WAITING") ||
      u === "CASCADE_RUN_STATUS_RUNNING" ||
      u === "CASCADE_RUN_STATUS_WAITING_FOR_USER"
    );
  };
  /** @type {string | null} */
  let firstKey = null;
  /** @type {string | null} */
  let lastKey = null;
  for (const [cid, info] of map) {
    if (!firstKey) firstKey = cid;
    lastKey = cid;
    if (isActive(info.status)) return cid;
  }
  return lastKey || firstKey || "";
}

/** @param {unknown} step */
function extractFromStepObject(step) {
  if (!step || typeof step !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (step);

  const pr =
    o.plannerResponse ?? o.planner_response;
  if (pr && typeof pr === "object") {
    const p = /** @type {Record<string, unknown>} */ (pr);
    const t =
      (typeof p.modifiedResponse === "string" && p.modifiedResponse) ||
      (typeof p.modified_response === "string" && p.modified_response) ||
      (typeof p.response === "string" && p.response);
    if (t && String(t).trim()) return String(t).trim();
  }

  const fin = o.finish;
  if (fin && typeof fin === "object") {
    const f = /** @type {Record<string, unknown>} */ (fin);
    const os =
      (typeof f.outputString === "string" && f.outputString) ||
      (typeof f.output_string === "string" && f.output_string);
    if (os && String(os).trim()) return String(os).trim();
  }

  const ep = o.ephemeralMessage ?? o.ephemeral_message;
  if (ep && typeof ep === "object") {
    const e = /** @type {Record<string, unknown>} */ (ep);
    if (typeof e.content === "string" && e.content.trim()) return e.content.trim();
  }

  return null;
}

/**
 * Walk gemini_coder.Step list including nested subtrajectory.steps.
 * @param {unknown[]} steps
 * @param {(s: unknown) => void} visit
 */
function walkStepsDeep(steps, visit) {
  if (!Array.isArray(steps)) return;
  for (const s of steps) {
    visit(s);
    if (!s || typeof s !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (s);
    const sub = o.subtrajectory ?? o.subTrajectory;
    if (sub && typeof sub === "object") {
      const t = /** @type {Record<string, unknown>} */ (sub);
      const inner = t.steps;
      if (Array.isArray(inner)) walkStepsDeep(inner, visit);
    }
  }
}

/**
 * Last non-empty assistant-like string wins (matches UI reading order).
 * @param {unknown} stepsPayload — GetCascadeTrajectoryStepsResponse
 */
export function extractAssistantReply(stepsPayload) {
  const parsed =
    stepsPayload &&
    typeof stepsPayload === "object" &&
    /** @type {Record<string, unknown>} */ (stepsPayload).steps;
  const steps = Array.isArray(parsed) ? parsed : [];
  let last = null;
  walkStepsDeep(steps, (s) => {
    const t = extractFromStepObject(s);
    if (t) last = t;
  });
  return last;
}
