import type { Project } from "../db/types.js";
import type { ProjectRepoAccessDecision, RoomAccessAccount } from "../rooms/access.js";

export interface DesktopPushAuthorizationDeps {
  getProject(roomId: string): Promise<Project | null | undefined>;
  getAccount(accountId: string): Promise<RoomAccessAccount | null | undefined>;
  resolveAccess(input: {
    project: Project;
    sessionAccount: RoomAccessAccount;
    freshCollaboratorCheck: boolean;
  }): Promise<ProjectRepoAccessDecision>;
  /** Membership of a room that is not tied to a repository (its parent, for a focus room). */
  isRoomMember(project: Project, accountId: string): Promise<boolean>;
}

export type DesktopPushAuthorizationDecision = "allow" | "deny" | "retry";

export async function authorizeDesktopPushNotification(
  input: {
    accountId: string;
    roomId: string;
    /** Defaults to true. The push worker keeps the default; the emit path passes false. */
    freshCollaboratorCheck?: boolean;
  },
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
    freshCollaboratorCheck: input.freshCollaboratorCheck ?? true,
  });
  // Only members of a room without a repository get its pushes.
  if (!access.isRepoBacked) return await deps.isRoomMember(project, account.account_id) ? "allow" : "deny";
  if (access.decision.kind === "allow") return "allow";

  // No account can open a repo room on a host other than github.com, so a
  // missing GitHub credential is not the cause and a retry cannot help.
  if (access.decision.kind === "unsupported_repo_provider") return "deny";
  // A public repository: GitHub answered that this person has no role on it.
  if (access.decision.kind === "repo_collaborator_required" && account.provider_access_token) return "deny";

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
