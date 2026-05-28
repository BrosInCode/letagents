import { createHash } from "node:crypto";

import type { ContinuityPack } from "./types.js";

export function computePackId(pack: ContinuityPack): string {
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
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = (value as Record<string, unknown>)[key];
    }
    return sorted;
  }
  return value;
}
