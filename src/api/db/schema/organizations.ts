import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { accounts } from "./core.js";

// A company groups repo rooms; it is not itself a room. Use GitHub's immutable
// ID as identity so a rename cannot create a second company or transfer access.
export const organizations = pgTable("organizations", {
  github_org_id: text("github_org_id").primaryKey(),
  login: text("login").notNull(),
  avatar_url: text("avatar_url"),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true }).notNull(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true }).notNull(),
});

// Records people who have joined LetAgents, not every employee on GitHub.
// Membership is reverified with GitHub before company access; this stored role
// is not an independent authorization grant and never grants repo access.
export const organization_memberships = pgTable("organization_memberships", {
  organization_id: text("organization_id").notNull()
    .references(() => organizations.github_org_id, { onDelete: "cascade" }),
  account_id: text("account_id").notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  role: text("role").notNull().$type<"owner" | "member">(),
  joined_at: timestamp("joined_at", { mode: "string", withTimezone: true }).notNull(),
  verified_at: timestamp("verified_at", { mode: "string", withTimezone: true }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.organization_id, table.account_id] }),
  account_idx: index("organization_memberships_account_idx").on(table.account_id),
  role_check: check("organization_memberships_role_check", sql`${table.role} IN ('owner', 'member')`),
}));
