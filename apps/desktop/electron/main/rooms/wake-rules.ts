import type { WakeRule, WakeRulePage } from "../../../../../shared/wake-rules.mjs";
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
