import { and, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { tracker_connections } from "../db/schema.js";
import { connectorErrorText } from "./connections.js";
import { parseGitHubIssuesWebhook } from "./providers/github.js";
import type { ExternalItemChange } from "./providers/types.js";
import type { TrackerConnectionRow } from "./store.js";
import { getDefaultTrackerSync, type TrackerSync } from "./sync.js";

export interface GitHubIssuesEventDeps {
  sync: Pick<TrackerSync, "handleWebhook"> | null;
  /** Active GitHub Issues connections on the installation. */
  connectionsForInstallation(installationId: string): Promise<TrackerConnectionRow[]>;
}

const defaultDeps = (): GitHubIssuesEventDeps => ({
  sync: getDefaultTrackerSync(),
  async connectionsForInstallation(installationId) {
    return db.select().from(tracker_connections).where(and(
      eq(tracker_connections.provider, "github"),
      eq(tracker_connections.site_key, `installation:${installationId}`),
      eq(tracker_connections.status, "active"),
    ));
  },
});

/**
 * A GitHub App `issues` delivery (already verified by the App's webhook
 * route) for the GitHub Issues connections on that installation. It takes the
 * same path as a Jira or Linear webhook: the payload only names the issue,
 * and sync reads it again through each connection's access checks.
 */
export async function applyGitHubIssuesEvent(
  payload: unknown,
  installationId: string | null,
  deps: GitHubIssuesEventDeps = defaultDeps(),
): Promise<number> {
  if (!installationId || !deps.sync) return 0;
  const changes: ExternalItemChange[] = parseGitHubIssuesWebhook(payload);
  if (changes.length === 0) return 0;
  let applied = 0;
  for (const connection of await deps.connectionsForInstallation(installationId)) {
    try {
      applied += (await deps.sync.handleWebhook(connection, changes)).applied;
    } catch (error) {
      console.error("GitHub Issues event apply failed:", connectorErrorText(error));
    }
  }
  return applied;
}
