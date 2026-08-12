import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  getSupervisorAccessRevocationTarget,
  revalidateSupervisorGrantsForRepositoryAccessChange,
} = await import("../github/webhook-handler.js");

const repository = {
  id: 42,
  name: "letagents",
  full_name: "BrosInCode/letagents",
};

test("repository privatization invalidates every repo-scoped supervisor grant", () => {
  assert.deepEqual(
    getSupervisorAccessRevocationTarget("repository", {
      action: "privatized",
      repository,
    }),
    {
      repository_full_name: "BrosInCode/letagents",
      canonical_room_id: "github.com/brosincode/letagents",
      owner_login: null,
    },
  );
});

test("repository member removal invalidates only the removed login's grants", () => {
  assert.deepEqual(
    getSupervisorAccessRevocationTarget("member", {
      action: "removed",
      repository,
      member: { id: 7, login: "removed-collaborator" },
    }),
    {
      repository_full_name: "BrosInCode/letagents",
      canonical_room_id: "github.com/brosincode/letagents",
      owner_login: "removed-collaborator",
    },
  );
});

test("unrelated repository and member events do not revoke supervisor grants", () => {
  assert.equal(getSupervisorAccessRevocationTarget("repository", {
    action: "publicized",
    repository,
  }), null);
  assert.equal(getSupervisorAccessRevocationTarget("member", {
    action: "added",
    repository,
    member: { id: 7, login: "collaborator" },
  }), null);
  assert.equal(getSupervisorAccessRevocationTarget("member", {
    action: "removed",
    repository: { ...repository, private: false },
    member: { id: 7, login: "collaborator" },
  }), null);
  assert.equal(getSupervisorAccessRevocationTarget("push", { repository }), null);
});

test("authorization-boundary webhooks revoke only after a fresh definitive denial", async () => {
  const revoked: string[] = [];
  let access: "allow" | "deny" | "indeterminate" = "allow";
  const grant = {
    grant_id: "grant_webhook", owner_account_id: "owner_webhook", host_id: "host",
    installation_id: "installation", scope_key: "owner", rental_session_id: null,
    token_version: 1, allowed_room_ids: ["github.com/brosincode/letagents"],
    allowed_agent_keys: ["owner/agent"], current_generation: 1,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
    revoked_at: null,
  };
  const deps = {
    listAuthorities: async () => [{ grant_id: grant.grant_id, owner_account_id: grant.owner_account_id }],
    getGrant: async () => grant,
    getOwner: async () => ({
      account_id: grant.owner_account_id, provider: "github", login: "owner",
      provider_access_token: "live-token",
    }),
    resolveAccess: async (input: any) => {
      assert.equal(input.freshCollaboratorCheck, true);
      assert.equal(input.throwOnIndeterminate, true);
      if (access === "indeterminate") throw new Error("GitHub throttled");
      return access === "allow" ? { kind: "allow" as const } : { kind: "private_repo_no_access" as const };
    },
    revokeAuthority: async (authority: { grant_id: string }) => {
      revoked.push(authority.grant_id);
      return { grant, revoked_now: true, ended_session_ids: [] };
    },
  };
  const target = getSupervisorAccessRevocationTarget("repository", {
    action: "privatized",
    repository: { ...repository, private: true },
  });
  assert.ok(target);

  await revalidateSupervisorGrantsForRepositoryAccessChange(target, deps as never);
  assert.deepEqual(revoked, [], "a still-authorized owner survives the webhook");

  access = "indeterminate";
  await assert.rejects(
    revalidateSupervisorGrantsForRepositoryAccessChange(target, deps as never),
    /indeterminate/i,
  );
  assert.deepEqual(revoked, [], "provider uncertainty is retried without teardown");

  access = "deny";
  await revalidateSupervisorGrantsForRepositoryAccessChange(target, deps as never);
  assert.deepEqual(revoked, [grant.grant_id]);
});
