import type { CompanyInviteView } from "./types";

interface MembershipLike { github_org_id: string; login: string; avatar_url: string | null; role: "owner" | "member"; setup: boolean; joined: boolean }
interface InvitationLike { github_org_id: string; login: string; avatar_url: string | null }
interface SsoBlockLike { github_org_id: string; login: string | null }

/** Accept only GitHub's numeric organization IDs in a company link. */
export function isCompanyLinkId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
}

/**
 * What a company link shows for one organization ID, from the person's GitHub
 * organizations. The order matters: a membership wins over an invitation, and
 * a missing permission or outage says nothing about membership at all.
 */
export function companyInviteView(input: {
  id: string;
  status: "idle" | "loading" | "ready" | "github_access_required" | "unavailable";
  accessReason?: "scope" | "signin" | null;
  organizations: readonly MembershipLike[];
  invitations: readonly InvitationLike[];
  ssoRequired: readonly SsoBlockLike[];
  viewerLogin: string | null;
  /** Set right after a join or setup in this panel. */
  justJoined?: boolean;
  roomCount?: number | null;
}): CompanyInviteView {
  if (!isCompanyLinkId(input.id)) return { kind: "invalid" };
  if (input.status === "idle" || input.status === "loading") return { kind: "loading" };
  if (input.status === "github_access_required") return { kind: "github_access_required", reason: input.accessReason ?? "scope" };
  if (input.status === "unavailable") return { kind: "unavailable" };
  const org = input.organizations.find((item) => item.github_org_id === input.id);
  if (org) {
    const organization = { login: org.login, avatar_url: org.avatar_url };
    if (org.joined) return { kind: "joined", organization, roomCount: input.roomCount ?? null, justJoined: Boolean(input.justJoined) };
    if (org.setup) return { kind: "join", organization };
    return org.role === "owner" ? { kind: "setup", organization } : { kind: "waiting", organization };
  }
  const invitation = input.invitations.find((item) => item.github_org_id === input.id);
  if (invitation) return { kind: "invited", organization: { login: invitation.login, avatar_url: invitation.avatar_url } };
  const sso = input.ssoRequired.find((item) => item.github_org_id === input.id);
  if (sso) return { kind: "sso", organization: sso.login ? { login: sso.login, avatar_url: null } : null };
  return { kind: "not_member", viewerLogin: input.viewerLogin };
}
