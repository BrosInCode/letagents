import type { TrackerProvider } from "../../../../shared/ticket-connectors.mjs";
import { getTrackerOAuthConfig, refreshTrackerTokens } from "../oauth.js";
import { createGitHubIssuesProvider, type GitHubAppDirectory, type GitHubIssuesProvider } from "./github.js";
import { createJiraProvider } from "./jira.js";
import { createLinearProvider } from "./linear.js";
import type { WorkItemProvider } from "./types.js";

export type WorkItemProviders = Record<Exclude<TrackerProvider, "github">, WorkItemProvider> & { github: GitHubIssuesProvider };

/** The server's providers, refreshing OAuth tokens with the configured apps. */
export function createWorkItemProviders(options: {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  githubDirectory?: GitHubAppDirectory;
} = {}): WorkItemProviders {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const refresher = (provider: TrackerProvider) => {
    const config = getTrackerOAuthConfig(provider, env);
    return config ? (refreshToken: string) => refreshTrackerTokens(provider, config, refreshToken, fetchImpl) : null;
  };
  return {
    jira: createJiraProvider({ fetchImpl, env, refresh: refresher("jira") }),
    linear: createLinearProvider({ fetchImpl, refresh: refresher("linear") }),
    github: createGitHubIssuesProvider({ fetchImpl, directory: options.githubDirectory }),
  };
}
