import type {
  WakeRule,
  WakeRulePage,
  WakeRuleTestResult,
  WakeWebhookAgent,
  WakeWebhookFormInput,
} from "../../../../../shared/wake-rules.mjs";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

/** Wake rules live on the server; a room kept only on this Mac has none. */
async function wakeRulesPath(identifier: string, suffix = ""): Promise<{ path: string | null; roomId: string }> {
  if (!identifier?.trim()) throw new Error("Choose a room first.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") return { path: null, roomId: identifier };
  const roomId = cloudRoomIdentifierForStorage(storage, identifier);
  return { path: `/rooms/${encodeURIComponent(roomId)}/wake-rules${suffix}`, roomId };
}

function ruleIdSegment(ruleId: string): string {
  if (!/^wake_[a-z0-9]{1,40}$/.test(ruleId)) throw new Error("Unknown wake rule.");
  return ruleId;
}

export async function getDesktopRoomWakeRules(identifier: string): Promise<WakeRulePage> {
  const { path, roomId } = await wakeRulesPath(identifier);
  return path ? apiFetch(path) : { room_id: roomId, active: [], recent: [] };
}

async function changeWakeRule(identifier: string, ruleId: string, action: "cancel" | "restore"): Promise<WakeRule> {
  const { path } = await wakeRulesPath(identifier, `/${ruleIdSegment(ruleId)}/${action}`);
  if (!path) throw new Error("Wake rules need a room shared online.");
  const response = await apiFetch<{ rule: WakeRule }>(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  return response.rule;
}

export const cancelDesktopRoomWakeRule = (identifier: string, ruleId: string) => changeWakeRule(identifier, ruleId, "cancel");
export const restoreDesktopRoomWakeRule = (identifier: string, ruleId: string) => changeWakeRule(identifier, ruleId, "restore");

/** The agents the signed-in person owns in the room: the webhook wake-up form's agent picker. A room kept only on this Mac has none. */
export async function listDesktopRoomWakeWebhookAgents(identifier: string): Promise<WakeWebhookAgent[]> {
  const { path } = await wakeRulesPath(identifier, "/my-agents");
  if (!path) return [];
  return (await apiFetch<{ agents: WakeWebhookAgent[] }>(path)).agents;
}

/**
 * Add (or renew) a room.message webhook rule for one of the person's own
 * agents. The URL, secret and key go to the server once; the answer never
 * carries them.
 */
export async function addDesktopRoomWakeWebhookRule(
  identifier: string,
  agentKey: string,
  input: WakeWebhookFormInput,
): Promise<{ rule: WakeRule; created: boolean }> {
  const { path } = await wakeRulesPath(identifier);
  if (!path) throw new Error("Wake rules need a room shared online.");
  if (!agentKey?.trim()) throw new Error("Choose one of your agents first.");
  const rule = {
    event: "room.message",
    ...(input.note ? { note: input.note } : {}),
    webhook: { url: input.url, secret: input.secret, ...(input.bearer ? { bearer: input.bearer } : {}) },
  };
  return apiFetch<{ rule: WakeRule; created: boolean }>(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_key: agentKey, rule }),
  });
}

/** One test delivery to the rule's receiver; the result comes back at once (the server waits at most 10 s). */
export async function testDesktopRoomWakeRule(identifier: string, ruleId: string): Promise<WakeRuleTestResult> {
  const { path } = await wakeRulesPath(identifier, `/${ruleIdSegment(ruleId)}/test`);
  if (!path) throw new Error("Wake rules need a room shared online.");
  return apiFetch<WakeRuleTestResult>(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }, { timeoutMs: 20_000 });
}
