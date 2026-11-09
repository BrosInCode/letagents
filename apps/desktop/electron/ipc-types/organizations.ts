export interface DesktopOrganization {
  github_org_id: string;
  login: string;
  avatar_url: string | null;
  role: "owner" | "member";
  setup: boolean;
  joined: boolean;
}

/** A GitHub organization invitation the person has not accepted on GitHub yet. */
export interface DesktopOrganizationInvitation {
  github_org_id: string;
  login: string;
  avatar_url: string | null;
}

/** An organization GitHub left out because the sign-in is not authorized for its single sign-on. */
export interface DesktopOrganizationSsoBlock {
  github_org_id: string;
  login: string | null;
}

/** Why GitHub access must be granted again: the sign-in lacks organization access, or GitHub no longer accepts it. */
export type DesktopGitHubAccessReason = "scope" | "signin";

export type DesktopOrganizationList =
  | {
    status: "ok";
    organizations: DesktopOrganization[];
    invitations: DesktopOrganizationInvitation[];
    ssoRequired: DesktopOrganizationSsoBlock[];
  }
  | { status: "github_access_required"; reason: DesktopGitHubAccessReason }
  | { status: "unavailable" };

export interface DesktopOrganizationRoom {
  /** A repo room of the company, or a room with no repository that belongs to the company. */
  kind: "repo" | "room";
  github_repo_id: string | null;
  room_id: string;
  display_name: string;
  full_name: string | null;
  organization_id: string;
  visibility: "public" | "private" | null;
}

export type DesktopOrganizationRooms =
  | { status: "ok"; rooms: DesktopOrganizationRoom[] }
  | { status: "github_access_required"; reason: DesktopGitHubAccessReason }
  | { status: "sso_required" }
  | { status: "membership_required" }
  | { status: "unavailable" };

export type DesktopOrganizationJoinResult =
  | { status: "ok" }
  | { status: "github_access_required"; reason: DesktopGitHubAccessReason }
  | { status: "membership_required" }
  | { status: "owner_required" }
  | { status: "setup_required" }
  | { status: "sso_required" }
  | { status: "unavailable" };

/** GitHub pages the app may open for a company. The main process builds every URL. */
export type DesktopOrganizationGitHubPage =
  | { kind: "allow" }
  | { kind: "invitation"; login: string }
  | { kind: "sso"; login: string };

export interface DesktopOrganizationApi {
  /** The organization ID of a company link saved at launch, if any. */
  pendingInvite: () => Promise<string | null>;
  /** Forget a company link once the person has answered it. */
  acknowledgeInvite: (id: string) => Promise<void>;
  /** A company link that arrives while the app runs. */
  onInvited: (callback: (id: string) => void) => () => void;
  list: () => Promise<DesktopOrganizationList>;
  join: (id: string, setup: boolean) => Promise<DesktopOrganizationJoinResult>;
  rooms: (id: string) => Promise<DesktopOrganizationRooms>;
  openOnGitHub: (page: DesktopOrganizationGitHubPage) => Promise<void>;
}
