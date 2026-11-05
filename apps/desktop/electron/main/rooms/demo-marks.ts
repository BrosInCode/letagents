import { isLiveDemoKey, parseDemoMark, parseDemoMarkInput } from "../../../../../shared/live-demo.mjs";
import type { DesktopDemoMark, DesktopDemoMarkInput } from "../../ipc-types.js";
import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

const MARK_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The room's path on the server, or null for a room kept only on this computer. */
async function cloudRoomPath(rawRoom: unknown): Promise<string | null> {
  const identifier = typeof rawRoom === "string" ? rawRoom.trim() : "";
  if (!identifier) throw new Error("Choose a room first.");
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") return null;
  return `/rooms/${encodeURIComponent(cloudRoomIdentifierForStorage(storage, identifier))}`;
}

async function requireCloudRoomPath(rawRoom: unknown): Promise<string> {
  const path = await cloudRoomPath(rawRoom);
  if (!path) throw new Error("Marks are saved only in rooms on the LetAgents server.");
  return path;
}

/** The saved marks on one demo; ones this app cannot read are left out. A room only on this computer has none. */
export async function listDesktopDemoMarks(room: unknown, demoKey: unknown): Promise<DesktopDemoMark[]> {
  if (!isLiveDemoKey(demoKey)) throw new Error("This demo cannot hold marks.");
  const path = await cloudRoomPath(room);
  if (!path) return [];
  const response = await apiFetch<{ marks?: unknown }>(
    `${path}/demo-marks?${new URLSearchParams({ demo: demoKey }).toString()}`,
    undefined,
    { credential: "app" },
  );
  const marks = Array.isArray(response?.marks) ? response.marks : [];
  return marks.flatMap((value) => {
    const mark = parseDemoMark(value);
    return mark && mark.demo === demoKey ? [mark] : [];
  });
}

export async function addDesktopDemoMark(room: unknown, rawInput: unknown): Promise<DesktopDemoMark> {
  const input: DesktopDemoMarkInput | null = parseDemoMarkInput(rawInput);
  if (!input) throw new Error("This mark cannot be saved.");
  const path = await requireCloudRoomPath(room);
  const response = await apiFetch<{ mark?: unknown }>(
    `${path}/demo-marks`,
    { method: "POST", body: JSON.stringify(input) },
    { credential: "app" },
  );
  const mark = parseDemoMark(response?.mark);
  if (!mark || mark.demo !== input.demo) throw new Error("The mark was saved, but the app could not read it back.");
  return mark;
}

export async function removeDesktopDemoMark(room: unknown, markId: unknown): Promise<void> {
  if (typeof markId !== "string" || !MARK_ID.test(markId)) throw new Error("This mark cannot be removed.");
  const path = await requireCloudRoomPath(room);
  await apiFetch<void>(`${path}/demo-marks/${encodeURIComponent(markId)}`, { method: "DELETE" }, { credential: "app" });
}
