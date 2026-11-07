import type { IpcMain } from "electron";
import type { DesktopOrganization, DesktopOrganizationRoom } from "../ipc-types/organizations.js";
import { apiFetch } from "./auth.js";
import { acknowledgeCompanyLink, getPendingCompanyLink } from "./company-links.js";

function organizationId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new Error("Choose a valid GitHub organization.");
  return value;
}

export function registerOrganizationIpcHandlers(ipc: IpcMain): void {
  ipc.handle("desktop:organizations:pending", () => getPendingCompanyLink());
  ipc.handle("desktop:organizations:acknowledge", (_event, id: unknown) => acknowledgeCompanyLink(id));
  ipc.handle("desktop:organizations:list", async () => {
    const response = await apiFetch<{ organizations: DesktopOrganization[] }>("/account/organizations", undefined, { timeoutMs: 40_000 });
    return response.organizations;
  });
  ipc.handle("desktop:organizations:join", async (_event, id: unknown, setup: unknown) => {
    if (typeof setup !== "boolean") throw new Error("Choose whether to join or set up the company.");
    await apiFetch(`/organizations/${organizationId(id)}/${setup ? "setup" : "join"}`, { method: "POST" }, { timeoutMs: 40_000 });
  });
  ipc.handle("desktop:organizations:rooms", async (_event, id: unknown) => {
    const response = await apiFetch<{ rooms: DesktopOrganizationRoom[] }>(`/organizations/${organizationId(id)}/rooms`, undefined, { timeoutMs: 40_000 });
    return response.rooms;
  });
}
