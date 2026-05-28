import { eq } from "drizzle-orm";

import { db } from "../client.js";
import { toGitHubAppInstallation } from "../mappers.js";
import { github_app_installations } from "../schema.js";
import type { GitHubAppInstallation } from "../types.js";
import { serializeGitHubPermissions } from "./permissions.js";

export async function upsertGitHubAppInstallation(input: {
  installation_id: string;
  target_type: string;
  target_login: string;
  target_github_id: string;
  repository_selection: string;
  permissions?: Record<string, string> | null;
  suspended_at?: string | null;
  uninstalled_at?: string | null;
}): Promise<GitHubAppInstallation> {
  const now = new Date().toISOString();
  const permissions_json = serializeGitHubPermissions(input.permissions);

  const [installation] = await db
    .insert(github_app_installations)
    .values({
      installation_id: input.installation_id,
      target_type: input.target_type,
      target_login: input.target_login,
      target_github_id: input.target_github_id,
      repository_selection: input.repository_selection,
      permissions_json,
      suspended_at: input.suspended_at ?? null,
      uninstalled_at: input.uninstalled_at ?? null,
      last_synced_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: github_app_installations.installation_id,
      set: {
        target_type: input.target_type,
        target_login: input.target_login,
        target_github_id: input.target_github_id,
        repository_selection: input.repository_selection,
        permissions_json,
        suspended_at: input.suspended_at ?? null,
        uninstalled_at: input.uninstalled_at ?? null,
        last_synced_at: now,
        updated_at: now,
      },
    })
    .returning();

  return toGitHubAppInstallation(installation);
}

export async function markGitHubAppInstallationUninstalled(
  installationId: string,
  uninstalledAt = new Date().toISOString()
): Promise<void> {
  await db
    .update(github_app_installations)
    .set({
      uninstalled_at: uninstalledAt,
      last_synced_at: uninstalledAt,
      updated_at: uninstalledAt,
    })
    .where(eq(github_app_installations.installation_id, installationId));
}

export async function setGitHubAppInstallationSuspended(
  installationId: string,
  suspendedAt: string | null
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(github_app_installations)
    .set({
      suspended_at: suspendedAt,
      last_synced_at: now,
      updated_at: now,
    })
    .where(eq(github_app_installations.installation_id, installationId));
}

export async function getGitHubAppInstallationById(
  installationId: string
): Promise<GitHubAppInstallation | undefined> {
  const [installation] = await db
    .select()
    .from(github_app_installations)
    .where(eq(github_app_installations.installation_id, installationId))
    .limit(1);

  return installation ? toGitHubAppInstallation(installation) : undefined;
}
