import crypto from "crypto";

const GITHUB_APP_SETUP_STATE_PREFIX = "github_app_setup_";

export function createGitHubAppSetupState(): string {
  return `${GITHUB_APP_SETUP_STATE_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
}

export function isGitHubAppSetupState(state: string | undefined): boolean {
  return Boolean(state?.startsWith(GITHUB_APP_SETUP_STATE_PREFIX));
}

