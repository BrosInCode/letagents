/** What the company home says: the company has no rooms, a check is running, GitHub refused or did not answer, or a room should be picked. */
export type CompanyHomeState = "empty" | "loading" | "unavailable" | "github_access_required" | "sso_required" | "choose";
