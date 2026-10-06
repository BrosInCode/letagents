import type { DesktopPullRequestDiff, DesktopPullRequestDiffResult } from "../../ipc-types/room.js";
import { apiFetch, DesktopApiError } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

export async function getDesktopPullRequestDiff(identifier: string, number: number): Promise<DesktopPullRequestDiffResult> {
  if (typeof identifier !== "string" || !identifier.trim() || !Number.isSafeInteger(number) || number <= 0) {
    return { ok: false, code: "invalid_request" };
  }
  try {
    const storage = await resolveLocalAwareRoomStorageMode(identifier);
    if (storage.effectiveMode === "local") return { ok: false, code: "not_connected" };
    const room = cloudRoomIdentifierForStorage(storage, identifier);
    const value = await apiFetch<DesktopPullRequestDiff>(
      `/rooms/${encodeURIComponent(room)}/pull-requests/${number}/diff?include_files=1`,
    );
    if (typeof value.diff !== "string" || Buffer.byteLength(value.diff, "utf8") > 5 * 1024 * 1024) {
      return { ok: false, code: "too_large" };
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof DesktopApiError) {
      return { ok: false, code: error.payload?.code ?? (
        error.status === 401 || error.status === 403 ? "forbidden"
          : error.status === 404 ? "not_found" : error.status === 429 ? "rate_limited" : "upstream"
      ) };
    }
    return { ok: false, code: "unavailable" };
  }
}
