import type { IpcMain } from "electron";
import type {
  DesktopGitHubAccessReason,
  DesktopOrganization,
  DesktopOrganizationGitHubPage,
  DesktopOrganizationInvitation,
  DesktopOrganizationJoinResult,
  DesktopOrganizationList,
  DesktopOrganizationRoom,
  DesktopOrganizationRooms,
  DesktopOrganizationSsoBlock,
} from "../ipc-types/organizations.js";
import { apiFetch, DesktopApiError, readStoredAuth } from "./auth.js";
import { openAllowedExternalUrl, openExternalWebUrl } from "./external-url.js";
import { apiUrl } from "./paths.js";

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const COMPANY_TIMEOUT = { timeoutMs: 40_000 };

function organizationId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new Error("Choose a valid GitHub organization.");
  return value;
}

function githubLogin(value: unknown): string {
  if (typeof value !== "string" || !GITHUB_LOGIN.test(value)) throw new Error("Choose a valid GitHub organization.");
  return value;
}

/** The GitHub access answer for a refused company request, or null when the refusal is something else. */
function githubAccessReason(error: unknown): DesktopGitHubAccessReason | null {
  if (!(error instanceof DesktopApiError)) return null;
  const code = error.payload?.error;
  if (code === "github_scope_required") return "scope";
  if (code === "github_signin_required") return "signin";
  return null;
}

function errorCode(error: unknown): string | null {
  return error instanceof DesktopApiError ? error.payload?.error ?? null : null;
}

export async function listOrganizations(): Promise<DesktopOrganizationList> {
  try {
    const response = await apiFetch<{
      organizations: DesktopOrganization[];
      invitations?: DesktopOrganizationInvitation[];
      sso_required?: DesktopOrganizationSsoBlock[];
    }>("/account/organizations", undefined, COMPANY_TIMEOUT);
    return {
      status: "ok",
      organizations: response.organizations,
      invitations: response.invitations ?? [],
      ssoRequired: response.sso_required ?? [],
    };
  } catch (error) {
    const reason = githubAccessReason(error);
    return reason ? { status: "github_access_required", reason } : { status: "unavailable" };
  }
}

export async function joinOrganization(id: unknown, setup: unknown): Promise<DesktopOrganizationJoinResult> {
  if (typeof setup !== "boolean") throw new Error("Choose whether to join or set up the company.");
  const org = organizationId(id);
  try {
    await apiFetch(`/organizations/${org}/${setup ? "setup" : "join"}`, { method: "POST" }, COMPANY_TIMEOUT);
    return { status: "ok" };
  } catch (error) {
    const reason = githubAccessReason(error);
    if (reason) return { status: "github_access_required", reason };
    const code = errorCode(error);
    if (code === "organization_membership_required") return { status: "membership_required" };
    if (code === "organization_owner_required") return { status: "owner_required" };
    if (code === "organization_setup_required") return { status: "setup_required" };
    if (code === "organization_sso_required") return { status: "sso_required" };
    return { status: "unavailable" };
  }
}

export async function listOrganizationRooms(id: unknown): Promise<DesktopOrganizationRooms> {
  const org = organizationId(id);
  try {
    const response = await apiFetch<{ rooms: DesktopOrganizationRoom[] }>(`/organizations/${org}/rooms`, undefined, COMPANY_TIMEOUT);
    return { status: "ok", rooms: response.rooms };
  } catch (error) {
    const reason = githubAccessReason(error);
    if (reason) return { status: "github_access_required", reason };
    const code = errorCode(error);
    if (code === "organization_sso_required") return { status: "sso_required" };
    if (code === "organization_membership_required" || code === "organization_join_required") return { status: "membership_required" };
    return { status: "unavailable" };
  }
}

/** Build each GitHub page here, so the renderer never chooses a URL to open. */
export async function organizationGitHubPageUrl(page: DesktopOrganizationGitHubPage): Promise<string> {
  if (page?.kind === "invitation") return `https://github.com/orgs/${githubLogin(page.login)}/invitation`;
  if (page?.kind === "sso") return `https://github.com/orgs/${githubLogin(page.login)}/sso`;
  if (page?.kind !== "allow") throw new Error("Choose a GitHub page to open.");
  const url = new URL("/auth/github/organizations", apiUrl);
  const login = (await readStoredAuth()).account?.login;
  if (login && GITHUB_LOGIN.test(login)) url.searchParams.set("login", login);
  return url.toString();
}

export function registerOrganizationIpcHandlers(ipc: IpcMain): void {
  ipc.handle("desktop:organizations:list", () => listOrganizations());
  ipc.handle("desktop:organizations:join", (_event, id: unknown, setup: unknown) => joinOrganization(id, setup));
  ipc.handle("desktop:organizations:rooms", (_event, id: unknown) => listOrganizationRooms(id));
  ipc.handle("desktop:organizations:open-github", async (_event, page: DesktopOrganizationGitHubPage) => {
    const url = await organizationGitHubPageUrl(page);
    // The permission page is on the configured LetAgents server (http on a dev
    // machine); every other page is on github.com.
    if (page.kind === "allow") await openExternalWebUrl(url);
    else await openAllowedExternalUrl(url, ["github.com"]);
  });
}
