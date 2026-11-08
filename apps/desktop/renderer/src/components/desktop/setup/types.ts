import type {
  DesktopGitHubAccessReason,
  DesktopOrganization,
  DesktopOrganizationInvitation,
  DesktopOrganizationSsoBlock,
} from "../../../../../electron/ipc-types/organizations.js";
import type { CompanyListStatus } from "../../../composables/useDesktopOrganizations";

export type DesktopMcpWizardStep = "choose" | "install" | "done";
export type FirstRunWizardStage = "welcome" | "mcp" | "github" | "organization" | "room";

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
