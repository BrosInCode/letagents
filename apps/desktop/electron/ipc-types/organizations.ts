export interface DesktopOrganization {
  github_org_id: string;
  login: string;
  avatar_url: string | null;
  role: "owner" | "member";
  setup: boolean;
  joined: boolean;
}

export interface DesktopOrganizationRoom {
  github_repo_id: string;
  room_id: string;
  display_name: string;
  full_name: string;
  organization_id: string;
  visibility: "public" | "private";
}

export interface DesktopOrganizationApi {
  pendingInvite: () => Promise<string | null>;
  acknowledgeInvite: (id: string) => Promise<void>;
  onInvited: (callback: (id: string) => void) => () => void;
  list: () => Promise<DesktopOrganization[]>;
  join: (id: string, setup: boolean) => Promise<void>;
  rooms: (id: string) => Promise<DesktopOrganizationRoom[]>;
}
