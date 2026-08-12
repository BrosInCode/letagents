import type { Project } from "../db/types.js";
import type { ProjectRepoAccessDecision, RoomAccessAccount } from "../rooms/access.js";

export interface DesktopPushAuthorizationDeps {
  getProject(roomId: string): Promise<Project | null | undefined>;
  getAccount(accountId: string): Promise<RoomAccessAccount | null | undefined>;
  resolveAccess(input: {
    project: Project;
    sessionAccount: RoomAccessAccount;
    freshCollaboratorCheck: true;
  }): Promise<ProjectRepoAccessDecision>;
}

export type DesktopPushAuthorizationDecision = "allow" | "deny" | "retry";

export async function authorizeDesktopPushNotification(
  input: { accountId: string; roomId: string },
  deps: DesktopPushAuthorizationDeps,
): Promise<DesktopPushAuthorizationDecision> {
  const [project, account] = await Promise.all([
    deps.getProject(input.roomId),
    deps.getAccount(input.accountId),
  ]);
  if (!project || !account) return "deny";

  const access = await deps.resolveAccess({
    project,
    sessionAccount: account,
    freshCollaboratorCheck: true,
  });
  if (!access.isRepoBacked || access.decision.kind === "allow") return "allow";

  // A missing/expired provider credential is an authentication outage, not
  // proof that the account lost repository access. Preserve the backlog and
  // retry with the normal bounded worker policy until a live session refreshes
  // the account's GitHub token.
  if (
    account.provider === "github"
    && account.login
    && !account.provider_access_token
  ) {
    return "retry";
  }

  return "deny";
}
