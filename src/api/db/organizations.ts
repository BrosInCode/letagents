import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import { db } from "./client.js";
import { github_app_installations, github_app_repositories, organizations, organization_memberships, rooms } from "./schema.js";
import { roomThemeId, type RoomCompanyAppearance, type RoomThemeId } from "../../../shared/room-themes.mjs";
import type { GitHubOrganizationMembership } from "../github/organization-memberships.js";

export async function getOrganizationsForGitHubIds(ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(organizations).where(inArray(organizations.github_org_id, ids));
}

export async function getJoinedOrganizationIds(accountId: string): Promise<string[]> {
  const rows = await db.select({ id: organization_memberships.organization_id })
    .from(organization_memberships).where(eq(organization_memberships.account_id, accountId));
  return rows.map((row) => row.id);
}

// Call only after live provider verification. The caller enforces owner-only
// setup; joining an existing company never creates one implicitly.
export async function saveVerifiedOrganizationMembership(input: {
  accountId: string;
  membership: GitHubOrganizationMembership;
  create: boolean;
}) {
  return db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const org = input.membership;
    if (input.create) {
      await tx.insert(organizations).values({
        github_org_id: org.github_org_id,
        login: org.login,
        avatar_url: org.avatar_url,
        created_at: now,
        updated_at: now,
      }).onConflictDoNothing();
    }
    const [organization] = await tx.update(organizations).set({
      login: org.login,
      avatar_url: org.avatar_url,
      updated_at: now,
    }).where(eq(organizations.github_org_id, org.github_org_id)).returning();
    if (!organization) return null;
    await tx.insert(organization_memberships).values({
      organization_id: org.github_org_id,
      account_id: input.accountId,
      role: org.role,
      joined_at: now,
      verified_at: now,
    }).onConflictDoUpdate({
      target: [organization_memberships.organization_id, organization_memberships.account_id],
      set: { role: org.role, verified_at: now },
    });
    return organization;
  });
}

export async function removeOrganizationMembership(accountId: string, organizationId: string): Promise<void> {
  await db.delete(organization_memberships).where(and(
    eq(organization_memberships.account_id, accountId),
    eq(organization_memberships.organization_id, organizationId),
  ));
}


export async function setOrganizationTheme(id: string, theme: RoomThemeId | null) {
  const [organization] = await db.update(organizations).set({
    theme_id: theme,
    updated_at: new Date().toISOString(),
  }).where(eq(organizations.github_org_id, id)).returning({ theme: organizations.theme_id });
  return organization ?? null;
}

const companyAppearanceColumns = {
  id: organizations.github_org_id,
  name: organizations.login,
  theme: organizations.theme_id,
};

/** Resolve the actual room's company, including focus rooms and connected GitHub repositories. */
export async function getRoomCompanyAppearance(
  roomId: string,
  accessRoomId: string,
  repositoryId: string | null,
): Promise<RoomCompanyAppearance | null> {
  const explicit = await db.select({ ...companyAppearanceColumns, room: rooms.id })
    .from(rooms)
    .innerJoin(organizations, eq(organizations.github_org_id, rooms.organization_id))
    .where(inArray(rooms.id, roomId === accessRoomId ? [roomId] : [roomId, accessRoomId]));
  const owningCompany = explicit.find(company => company.room === roomId) ?? explicit[0];
  if (owningCompany) return { id: owningCompany.id, name: owningCompany.name, theme: roomThemeId(owningCompany.theme) };
  if (!repositoryId) return null;

  const [company] = await db.select(companyAppearanceColumns)
    .from(github_app_repositories)
    .innerJoin(github_app_installations, eq(github_app_installations.installation_id, github_app_repositories.installation_id))
    .innerJoin(organizations, eq(organizations.github_org_id, github_app_installations.target_github_id))
    .where(and(
      eq(github_app_repositories.github_repo_id, repositoryId),
      isNull(github_app_repositories.removed_at),
      isNull(github_app_installations.suspended_at),
      isNull(github_app_installations.uninstalled_at),
      ne(github_app_installations.target_type, "User"),
    ))
    .limit(1);
  return company ? { ...company, theme: roomThemeId(company.theme) } : null;
}
