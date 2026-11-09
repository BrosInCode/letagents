/** A GitHub organization as the invite panel shows it. */
export interface CompanyInviteOrganization {
  login: string;
  avatar_url: string | null;
}

/**
 * What a company link shows. GitHub decides each answer: the link itself
 * grants nothing.
 */
export type CompanyInviteView =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "signed_out" }
  | { kind: "unavailable" }
  | { kind: "github_access_required"; reason: "scope" | "signin" }
  /** A member of a company that an owner already set up. */
  | { kind: "join"; organization: CompanyInviteOrganization }
  /** An owner of an organization that nobody set up yet. */
  | { kind: "setup"; organization: CompanyInviteOrganization }
  /** A member of an organization that nobody set up yet. */
  | { kind: "waiting"; organization: CompanyInviteOrganization }
  | { kind: "joined"; organization: CompanyInviteOrganization; roomCount: number | null; justJoined: boolean }
  /** GitHub has an invitation the person has not accepted yet. */
  | { kind: "invited"; organization: CompanyInviteOrganization }
  /** GitHub hides the organization until LetAgents is authorized for its single sign-on. */
  | { kind: "sso"; organization: CompanyInviteOrganization | null }
  /** The signed-in GitHub account is not in the organization of the link. */
  | { kind: "not_member"; viewerLogin: string | null };

/** The buttons a view can show; the page that hosts the panel decides what each one does. */
export type CompanyInviteAction =
  | "join" | "setup" | "close" | "retry" | "allow" | "open_invitation" | "authorize_sso"
  | "show_rooms" | "sign_in";
