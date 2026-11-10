import type { Project } from "../db/types.js";
import { decideRoomRead, type RoomAccessAccount } from "../rooms/access-decision.js";

export interface DesktopPushAuthorizationDeps {
  getProject(roomId: string): Promise<Project | null | undefined>;
  getAccount(accountId: string): Promise<RoomAccessAccount | null | undefined>;
  /** The room read decision. Defaults to decideRoomRead. */
  decideRead?: typeof decideRoomRead;
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

  const access = await (deps.decideRead ?? decideRoomRead)({
    project,
    principal: { kind: "person", account },
    freshness: (input.freshCollaboratorCheck ?? true) ? "fresh" : "cached",
  });
  if (access.kind === "allow") return "allow";
  // Only members of a room without a repository get its pushes.
  if (access.target?.kind !== "repo") return "deny";

  // No account can open a repo room on a host other than github.com, so a
  // missing GitHub credential is not the cause and a retry cannot help.
  if (access.repo?.kind === "unsupported_repo_provider") return "deny";
  // GitHub gave no answer to the role check (outage, rate limit, expired
  // token), and no recent positive answer stood in: not a refusal, retry.
  if (access.kind === "indeterminate") return "retry";
  // A public repository: GitHub answered that this person has no role on it.
  if (access.repo?.kind === "repo_collaborator_required" && account.provider_access_token) return "deny";

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
