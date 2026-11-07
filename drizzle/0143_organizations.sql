CREATE TABLE organizations (
  github_org_id text PRIMARY KEY,
  login text NOT NULL,
  avatar_url text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE organization_memberships (
  organization_id text NOT NULL REFERENCES organizations(github_org_id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role text NOT NULL,
  joined_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  CONSTRAINT organization_memberships_organization_id_account_id_pk PRIMARY KEY (organization_id, account_id),
  CONSTRAINT organization_memberships_role_check CHECK (role IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE INDEX organization_memberships_account_idx ON organization_memberships(account_id);
