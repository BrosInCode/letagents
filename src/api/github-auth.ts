// Backward-compatible export surface while the API server migrates callers to
// narrower modules (`github-oauth`, `github-repo-access`, `github-config`).
export {
  getGitHubOAuthConfig,
  getGitHubAppConfig,
  hasGitHubAppConfig,
} from "./github-config.js";
export {
  buildGitHubAuthorizeUrl,
  exchangeGitHubCodeForAccessToken,
  requestGitHubDeviceCode,
  exchangeGitHubDeviceCodeForAccessToken,
  fetchGitHubUser,
} from "./github-oauth.js";
export {
  clearGitHubRepoAccessCacheForLogin,
  parseGitHubRepoName,
  getGitHubRepoVisibility,
  isGitHubRepoCollaborator,
  isGitHubRepoAdmin,
} from "./github-repo-access.js";
export type { GitHubAppConfig, GitHubOAuthConfig } from "./github-config.js";
export type { GitHubDeviceCodeResponse, GitHubUser } from "./github-oauth.js";
export type { GitHubRepoVisibility } from "./github-repo-access.js";
