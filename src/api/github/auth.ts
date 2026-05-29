// Backward-compatible export surface while the API server migrates callers to
// narrower modules (`github/oauth`, `github/repo-access`, `github/config`).
export {
  getGitHubOAuthConfig,
  getGitHubAppConfig,
  hasGitHubAppConfig,
} from "./config.js";
export {
  buildGitHubAuthorizeUrl,
  exchangeGitHubCodeForAccessToken,
  requestGitHubDeviceCode,
  exchangeGitHubDeviceCodeForAccessToken,
  fetchGitHubUser,
} from "./oauth.js";
export {
  clearGitHubRepoAccessCacheForLogin,
  parseGitHubRepoName,
  getGitHubRepoVisibility,
  isGitHubRepoCollaborator,
  isGitHubRepoAdmin,
} from "./repo-access.js";
export type { GitHubAppConfig, GitHubOAuthConfig } from "./config.js";
export type { GitHubDeviceCodeResponse, GitHubUser } from "./oauth.js";
export type { GitHubRepoVisibility } from "./repo-access.js";
