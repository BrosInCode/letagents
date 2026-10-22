import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ProviderUsage } from "../../../shared/provider-usage.js";
import { z } from "zod";

const timestamp = z.string().datetime();
export const providerUsageSchema = z.object({
  providerContinuationId: z.string().min(1),
  account: z.object({
    state: z.enum(["available", "stale", "unavailable"]),
    windows: z.array(z.object({
      id: z.string().min(1).max(160), label: z.string().min(1).max(160),
      usedPercent: z.number().finite().min(0).max(100),
      resetsAt: timestamp.nullable(), observedAt: timestamp,
    })).max(16),
  }),
  context: z.object({
    usedTokens: z.number().int().nonnegative(),
    capacityTokens: z.number().int().positive().nullable(),
    observedAt: timestamp,
  }).nullable(),
  compaction: z.enum(["compacting", "compacted"]).nullable(),
});
export const inspectorUsageSchema = providerUsageSchema.extend({
  executionGenerationId: z.string().min(1), daemonGeneration: z.number().int().nonnegative(),
});

export function emptyProviderUsage(providerContinuationId: string): ProviderUsage {
  return { providerContinuationId, account: { state: "unavailable", windows: [] }, context: null, compaction: null };
}


function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, 100) : null;
}
function epoch(value: unknown): string | null {
  const seconds = count(value);
  return seconds !== null && seconds < 253402300800 ? new Date(seconds * 1000).toISOString() : null;
}
function windowLabel(minutes: unknown, fallback: string): string {
  if (minutes === 300) return "5 hours";
  if (minutes === 10080) return "Weekly";
  const n = count(minutes);
  return n ? (n % 1440 === 0 ? `${n / 1440} days` : n % 60 === 0 ? `${n / 60} ${n === 60 ? "hour" : "hours"}` : `${n} minutes`) : fallback;
}

/** Only quota numbers leave the native connection; no account identity or credentials. */
export function codexAccountUsage(payload: unknown, observedAt: string): ProviderUsage["account"] {
  const source = row(payload);
  const buckets = row(source?.rateLimitsByLimitId);
  const snapshots = buckets && Object.keys(buckets).length ? Object.entries(buckets)
    : source?.rateLimits ? [[typeof row(source.rateLimits)?.limitId === "string" ? String(row(source.rateLimits)!.limitId) : "codex", source.rateLimits] as const] : [];
  const windows: ProviderUsage["account"]["windows"] = [];
  for (const [key, value] of snapshots) {
    const snapshot = row(value);
    for (const [slot, fallback] of [["primary", "Session"], ["secondary", "Secondary"]] as const) {
      const window = row(snapshot?.[slot]);
      const usedPercent = percent(window?.usedPercent);
      if (usedPercent === null) continue;
      const label = windowLabel(window?.windowDurationMins, fallback);
      const bucketLabel = typeof snapshot?.limitName === "string" ? snapshot.limitName : key;
      windows.push({ id: `${key}:${slot}`.slice(0, 160),
        label: (snapshots.length > 1 ? `${bucketLabel} · ${label}` : label).slice(0, 160),
        usedPercent, resetsAt: epoch(window?.resetsAt), observedAt });
    }
  }
  return { state: windows.length ? "available" : "unavailable", windows: windows.slice(0, 16) };
}

/** Retained per native handle, never across agents or replacement continuations. */
export class ProviderUsageTracker {
  private value: ProviderUsage;
  accountRevision = 0;
  private claudeModel: string | null = null;
  private claudeCapacities = new Map<string, number>();
  constructor(continuation: string) { this.value = emptyProviderUsage(continuation); }
  snapshot(continuation: string): ProviderUsage {
    if (continuation !== this.value.providerContinuationId) {
      this.value = emptyProviderUsage(continuation);
      this.claudeModel = null;
      this.claudeCapacities.clear();
    }
    return structuredClone(this.value);
  }
  seedContext(context: ProviderUsage["context"]): void {
    if (!this.value.context && !this.value.compaction) this.value.context = context;
  }
  account(payload: unknown, at: string, expectedRevision = this.accountRevision): void {
    if (expectedRevision !== this.accountRevision) return;
    this.value.account = codexAccountUsage(payload, at);
    this.accountRevision++;
  }
  accountFailed(expectedRevision = this.accountRevision): void {
    if (expectedRevision !== this.accountRevision) return;
    this.value.account.state = this.value.account.windows.length ? "stale" : "unavailable";
  }
  codex(method: string, payload: unknown, at: string): void {
    const data = row(payload);
    if (method === "account/rateLimits/updated") {
      // Notifications carry one bucket; do not erase other observed buckets.
      const account = codexAccountUsage(data, at);
      if (!account.windows.length) { this.accountFailed(); return; }
      this.accountRevision++;
      const bucket = typeof row(data?.rateLimits)?.limitId === "string" ? String(row(data?.rateLimits)!.limitId) : "codex";
      const ids = new Set(this.value.account.windows.filter(window => window.id.startsWith(`${bucket}:`)).map(window => window.id));
      this.value.account = { state: account.state, windows: [...this.value.account.windows.filter(window => !ids.has(window.id)), ...account.windows].slice(0, 16) };
      return;
    }
    if (data?.threadId !== this.value.providerContinuationId) return;
    const item = row(data.item);
    if (item?.type === "contextCompaction" && method === "item/started") this.value.compaction = "compacting";
    if ((item?.type === "contextCompaction" && method === "item/completed") || method === "thread/compacted") {
      this.value.context = null;
      this.value.compaction = "compacted";
    }
    if (method !== "thread/tokenUsage/updated") return;
    const usage = row(data.tokenUsage);
    const usedTokens = count(row(usage?.last)?.totalTokens);
    if (usedTokens === null) { this.value.context = null; return; }
    this.value.context = { usedTokens, capacityTokens: count(usage?.modelContextWindow) || null, observedAt: at };
    if (this.value.compaction === "compacting") this.value.compaction = null;
  }
  claude(payload: unknown, at: string): void {
    const data = row(payload);
    if (data?.session_id !== this.value.providerContinuationId || data.parent_tool_use_id != null) return;
    if (data.type === "rate_limit_event") {
      const info = row(data.rate_limit_info);
      const key = typeof info?.rateLimitType === "string" ? info.rateLimitType : null;
      // Newer CLIs report every window under unifiedWindows; older ones report one at the top level.
      const measured = new Map<string, { usedPercent: number; resetsAt: unknown }>();
      const topPercent = typeof info?.utilization === "number" ? percent(info.utilization * 100) : null;
      if (key && topPercent !== null) measured.set(key, { usedPercent: topPercent, resetsAt: info?.resetsAt });
      for (const [id, value] of Object.entries(row(info?.unifiedWindows) ?? {})) {
        const window = row(value);
        const usedPercent = typeof window?.utilization === "number" ? percent(window.utilization * 100) : null;
        if (usedPercent !== null) measured.set(id, { usedPercent, resetsAt: window?.resetsAt });
      }
      if (!measured.size && ["allowed", "allowed_warning", "rejected"].includes(String(info?.status))) {
        // A status-only update supersedes confidence in the previous number,
        // but cannot establish 0% or 100% utilization.
        this.accountFailed();
        const resetsAt = epoch(info?.resetsAt);
        if (key && resetsAt) this.value.account.windows = this.value.account.windows.map(window => window.id === key ? { ...window, resetsAt } : window);
      }
      if (measured.size) {
        const labels: Record<string, string> = { five_hour: "5 hours", seven_day: "Weekly", seven_day_opus: "Opus · Weekly", seven_day_sonnet: "Sonnet · Weekly", overage: "Extra usage" };
        const ids = new Set([...measured.keys()].map(id => id.slice(0, 160)));
        this.value.account = { state: "available", windows: [...this.value.account.windows.filter(window => !ids.has(window.id)),
          ...[...measured].map(([id, { usedPercent, resetsAt }]) => ({ id: id.slice(0, 160), label: (labels[id] ?? id.replaceAll("_", " ")).slice(0, 160), usedPercent, resetsAt: epoch(resetsAt), observedAt: at }))].slice(0, 16) };
      }
    }
    if (data.type === "system" && data.subtype === "compact_boundary") {
      this.value.context = null;
      this.value.compaction = "compacted";
    }
    if (data.type === "assistant") {
      const message = row(data.message);
      const usage = row(message?.usage);
      const input = count(usage?.input_tokens);
      if (typeof message?.model !== "string" || message.model === "<synthetic>"
        || data.error != null || data.is_error === true || input === null) return;
      this.claudeModel = message.model;
      // Claude's current context is input + both cache categories. Result.usage
      // and modelUsage token totals aggregate calls and must never be used here.
      const cached = usage?.cache_read_input_tokens == null ? 0 : count(usage.cache_read_input_tokens);
      const written = usage?.cache_creation_input_tokens == null ? 0 : count(usage.cache_creation_input_tokens);
      if (cached === null || written === null) return;
      this.value.context = { usedTokens: input + cached + written,
        capacityTokens: this.claudeCapacities.get(message.model) ?? null, observedAt: at };
    }
    if (data.type === "result") {
      for (const [model, value] of Object.entries(row(data.modelUsage) ?? {})) {
        const capacity = count(row(value)?.contextWindow);
        if (capacity) this.claudeCapacities.set(model, capacity);
      }
      if (this.value.context && this.claudeModel) this.value.context.capacityTokens = this.claudeCapacities.get(this.claudeModel) ?? null;
    }
  }
}

/** Bootstrap an idle, reattached Codex session from only its reported rollout's bounded tail. */
export async function readCodexUsageTail(path: unknown): Promise<ProviderUsage["context"]> {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - 512 * 1024);
    const buffer = Buffer.alloc(Math.min(stat.size, 512 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start) lines.shift();
    for (const line of lines.reverse()) {
      let data: Record<string, unknown> | null;
      try { data = row(JSON.parse(line)); } catch { continue; }
      // A compacted rollout's older token count is no longer current.
      if (data?.type === "compacted") return null;
      const payload = row(data?.payload);
      if (data?.type !== "event_msg" || payload?.type !== "token_count") continue;
      const info = row(payload.info);
      if (!info) continue;
      const usedTokens = count(row(info?.last_token_usage)?.total_tokens);
      const at = typeof data.timestamp === "string" ? data.timestamp : "";
      if (usedTokens === null || !Number.isFinite(Date.parse(at))) return null;
      return { usedTokens, capacityTokens: count(info?.model_context_window) || null, observedAt: new Date(at).toISOString() };
    }
    return null;
  } finally { await file.close(); }
}
