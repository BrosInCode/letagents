import type {
  DesktopBoardGovernanceAssignManagerInput,
  DesktopBoardGovernanceMutationResult,
  DesktopBoardGovernanceReleaseManagerInput,
  DesktopBoardGovernanceSetModeInput,
  DesktopBoardGovernanceSnapshot,
  DesktopBoardIntentDecisionInput,
} from "../../ipc-types/board-governance.js";
import { apiFetch } from "../auth.js";
import {
  cloudRoomIdentifierForStorage,
  resolveLocalAwareRoomStorageMode,
} from "./local-store.js";
import { mapDesktopBoardGovernanceSnapshot } from "./board-governance/mappers.js";
import type { BoardGovernanceApiResponse } from "./board-governance/payloads.js";

export { mapDesktopBoardGovernanceSnapshot } from "./board-governance/mappers.js";

async function resolveCloudRoomApiIdentifier(roomIdentifier: string): Promise<string> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  if (!trimmedRoomIdentifier) {
    throw new Error("Choose a room before loading board governance.");
  }
  const storage = await resolveLocalAwareRoomStorageMode(trimmedRoomIdentifier);
  if (storage.effectiveMode === "local") {
    throw new Error("Board governance is only available for cloud-backed rooms.");
  }
  return cloudRoomIdentifierForStorage(storage, trimmedRoomIdentifier);
}

export async function getDesktopBoardGovernance(
  roomIdentifier: string,
): Promise<DesktopBoardGovernanceSnapshot> {
  const apiRoomIdentifier = await resolveCloudRoomApiIdentifier(roomIdentifier);
  const data = await apiFetch<BoardGovernanceApiResponse>(
    `/rooms/${encodeURIComponent(apiRoomIdentifier)}/board-governance`,
  );
  return mapDesktopBoardGovernanceSnapshot(data);
}

export async function assignDesktopBoardManager(
  roomIdentifier: string,
  input: DesktopBoardGovernanceAssignManagerInput,
): Promise<DesktopBoardGovernanceMutationResult> {
  const apiRoomIdentifier = await resolveCloudRoomApiIdentifier(roomIdentifier);
  await apiFetch(
    `/rooms/${encodeURIComponent(apiRoomIdentifier)}/board-managers`,
    {
      method: "POST",
      body: JSON.stringify({
        agent_session_id: input.agentSessionId,
        runtime_source: input.runtimeSource ?? undefined,
      }),
    },
  );
  return { governance: await getDesktopBoardGovernance(roomIdentifier) };
}

export async function releaseDesktopBoardManager(
  roomIdentifier: string,
  input: DesktopBoardGovernanceReleaseManagerInput = {},
): Promise<DesktopBoardGovernanceMutationResult> {
  const apiRoomIdentifier = await resolveCloudRoomApiIdentifier(roomIdentifier);
  await apiFetch(
    `/rooms/${encodeURIComponent(apiRoomIdentifier)}/board-managers/active`,
    {
      method: "DELETE",
      body: JSON.stringify({
        reason: input.reason ?? undefined,
      }),
    },
  );
  return { governance: await getDesktopBoardGovernance(roomIdentifier) };
}

export async function setDesktopBoardManagerMode(
  roomIdentifier: string,
  input: DesktopBoardGovernanceSetModeInput,
): Promise<DesktopBoardGovernanceMutationResult> {
  const apiRoomIdentifier = await resolveCloudRoomApiIdentifier(roomIdentifier);
  await apiFetch(
    `/rooms/${encodeURIComponent(apiRoomIdentifier)}/board-settings`,
    {
      method: "PATCH",
      body: JSON.stringify({
        manager_mode: input.managerMode,
      }),
    },
  );
  return { governance: await getDesktopBoardGovernance(roomIdentifier) };
}

export async function decideDesktopBoardIntent(
  roomIdentifier: string,
  intentId: string,
  input: DesktopBoardIntentDecisionInput,
): Promise<DesktopBoardGovernanceMutationResult> {
  const apiRoomIdentifier = await resolveCloudRoomApiIdentifier(roomIdentifier);
  const action = input.decision === "approve" ? "approve" : "deny";
  await apiFetch(
    `/rooms/${encodeURIComponent(apiRoomIdentifier)}/board-intents/${encodeURIComponent(intentId)}/${action}`,
    {
      method: "POST",
      body: JSON.stringify({
        reason: input.reason ?? undefined,
        desktop_human_client: true,
      }),
    },
  );
  return { governance: await getDesktopBoardGovernance(roomIdentifier) };
}
