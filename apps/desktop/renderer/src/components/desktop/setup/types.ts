import type {
  DesktopGitHubAccessReason,
  DesktopOrganization,
  DesktopOrganizationInvitation,
  DesktopOrganizationRoom,
  DesktopOrganizationSsoBlock,
} from "../../../../../electron/ipc-types/organizations.js";
import type { CompanyListStatus } from "../../../composables/useDesktopOrganizations";

export type DesktopMcpWizardStep = "choose" | "install" | "done";
export type FirstRunWizardStage = "welcome" | "github" | "organization" | "theme" | "room";

/** What the company step shows: the person's GitHub organizations and where the check stands. */
export interface FirstRunCompanyStepState {
  status: CompanyListStatus;
  accessReason: DesktopGitHubAccessReason | null;
  organizations: DesktopOrganization[];
  invitations: DesktopOrganizationInvitation[];
  ssoRequired: DesktopOrganizationSsoBlock[];
  error: string | null;
  selectedId: string | null;
  joiningId: string | null;
}

export type FirstRunRoomChoice = Pick<DesktopOrganizationRoom, "kind" | "room_id" | "display_name" | "full_name" | "visibility"> & { local?: boolean };
