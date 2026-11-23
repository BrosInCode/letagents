/**
 * Account limits of the Antigravity sign-in, from `agy -p /quota --output-format json`
 * (agy 1.5.15). The answer lists model groups, each with a 5-hour and a weekly
 * bucket that says how much is left and when it refills. Only numbers leave
 * here: no account identity, no credential.
 */
import type { ProviderUsage } from "../../../../shared/provider-usage.js";
import { acpRecord, acpString } from "./acp-connection.js";

type AccountWindows = ProviderUsage["account"]["windows"];

/** Which quota group a model draws from: agy's groups are "Gemini Models" and "Claude and GPT models". */
export function antigravityQuotaGroupForModel(model: string | null | undefined): "gemini" | "third_party" | null {
  const id = model?.trim().toLowerCase() ?? "";
  if (!id) return null;
  if (id.startsWith("gemini")) return "gemini";
  if (id.startsWith("claude") || id.startsWith("gpt")) return "third_party";
  return null;
}

function groupKind(name: string): "gemini" | "third_party" | null {
  const lower = name.toLowerCase();
  if (lower.startsWith("gemini")) return "gemini";
  if (lower.includes("claude") || lower.includes("gpt")) return "third_party";
  return null;
}

/**
 * The windows of the agent's own model group, or of every group when the
 * model is unknown (agy's default). Labels name the group only when several are shown.
 */
export function parseAntigravityQuota(output: string, model: string | null | undefined, observedAt: string): AccountWindows | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    return null;
  }
  const groups = acpRecord(acpRecord(acpRecord(parsed)?.command)?.data)?.groups;
  if (!Array.isArray(groups)) return null;
  const wanted = antigravityQuotaGroupForModel(model);
  const chosen = groups.map(acpRecord).filter((group): group is Record<string, unknown> => {
    if (!group || !Array.isArray(group.buckets)) return false;
    return !wanted || groupKind(acpString(group.name) ?? "") === wanted;
  });
  const shown = chosen.length ? chosen : groups.map(acpRecord).filter((group): group is Record<string, unknown> => Boolean(group && Array.isArray(group.buckets)));
  const windows: AccountWindows = [];
  for (const group of shown) {
    const groupWindows: AccountWindows = [];
    const groupLabel = groupKind(acpString(group.name) ?? "") === "third_party" ? "Claude & GPT" : "Gemini";
    for (const bucket of group.buckets as unknown[]) {
      const record = acpRecord(bucket);
      const fraction = record?.remaining_fraction;
      const id = acpString(record?.id);
      if (!record || !id || typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
      const window = acpString(record.window);
      const label = window === "5h" ? "5 hours" : window === "weekly" ? "Weekly" : acpString(record.name) ?? id;
      const reset = acpString(record.reset_time);
      groupWindows.push({
        id: `antigravity:${id}`.slice(0, 160),
        label: (shown.length > 1 ? `${groupLabel} · ${label}` : label).slice(0, 160),
        usedPercent: Math.min(100, Math.max(0, Math.round((1 - fraction) * 1000) / 10)),
        resetsAt: reset && Number.isFinite(Date.parse(reset)) ? new Date(reset).toISOString() : null,
        observedAt,
      });
    }
    // 5-hour before weekly within each group, as the other providers show them.
    windows.push(...groupWindows.sort((a, b) => Number(a.label.endsWith("Weekly")) - Number(b.label.endsWith("Weekly"))));
  }
  return windows.slice(0, 16);
}
