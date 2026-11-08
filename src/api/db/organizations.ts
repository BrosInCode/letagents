import { and, eq, inArray } from "drizzle-orm";

import { db } from "./client.js";
import { organizations, organization_memberships } from "./schema.js";
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
