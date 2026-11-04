import assert from "node:assert/strict";
import test from "node:test";

import type { Project } from "../../db/types.js";
import { authorizeDesktopPushNotification } from "../authorization.js";

const project = { id: "github.com/acme/private" } as Project;
const account = {
  account_id: "acct_1",
  provider: "github",
  login: "octocat",
  provider_access_token: "token",
};

test("desktop push authorization requires a current account and room", async () => {
  const decision = await authorizeDesktopPushNotification(
    { accountId: account.account_id, roomId: project.id },
    {
      getProject: async () => null,
      getAccount: async () => account,
      resolveAccess: async () => {
        throw new Error("access should not be checked without a room");
      },
    },
  );
  assert.equal(decision, "deny");
});

test("desktop push authorization uses the fresh repository access gate", async () => {
  let freshCheck = false;
  const decision = await authorizeDesktopPushNotification(
    { accountId: account.account_id, roomId: project.id },
    {
      getProject: async () => project,
      getAccount: async () => account,
      resolveAccess: async (input) => {
        freshCheck = input.freshCollaboratorCheck;
        return {
          isRepoBacked: true,
          roomName: project.id,
          repoRoomName: project.id,
          binding: null,
          decision: { kind: "allow" },
        };
      },
    },
  );
  assert.equal(decision, "allow");
  assert.equal(freshCheck, true);
});

test("desktop push authorization rejects revoked repository access", async () => {
  const decision = await authorizeDesktopPushNotification(
    { accountId: account.account_id, roomId: project.id },
    {
      getProject: async () => project,
      getAccount: async () => account,
      resolveAccess: async () => ({
        isRepoBacked: true,
        roomName: project.id,
        repoRoomName: project.id,
        binding: null,
        decision: { kind: "private_repo_no_access" },
      }),
    },
  );
  assert.equal(decision, "deny");
});

test("desktop push authorization retries when a GitHub credential is absent", async () => {
  const decision = await authorizeDesktopPushNotification(
    { accountId: account.account_id, roomId: project.id },
    {
      getProject: async () => project,
      getAccount: async () => ({ ...account, provider_access_token: null }),
      resolveAccess: async () => ({
        isRepoBacked: true,
        roomName: project.id,
        repoRoomName: project.id,
        binding: null,
        decision: { kind: "private_repo_no_access" },
      }),
    },
  );
  assert.equal(decision, "retry");
});

test("desktop push authorization still allows a public repository without a token", async () => {
  const decision = await authorizeDesktopPushNotification(
    { accountId: account.account_id, roomId: project.id },
    {
      getProject: async () => project,
      getAccount: async () => ({ ...account, provider_access_token: null }),
      resolveAccess: async () => ({
        isRepoBacked: true,
        roomName: project.id,
        repoRoomName: project.id,
        binding: null,
        decision: { kind: "allow" },
      }),
    },
  );
  assert.equal(decision, "allow");
});

test("desktop push authorization denies a non-GitHub repo room even when the GitHub credential is absent", async () => {
  const bitbucketRoom = { id: "bitbucket.org/poppix/pdf-service" } as Project;
  const decision = await authorizeDesktopPushNotification(
    { accountId: account.account_id, roomId: bitbucketRoom.id },
    {
      getProject: async () => bitbucketRoom,
      getAccount: async () => ({ ...account, provider_access_token: null }),
      resolveAccess: async () => ({
        isRepoBacked: true,
        roomName: bitbucketRoom.id,
        repoRoomName: bitbucketRoom.id,
        binding: null,
        decision: { kind: "unsupported_repo_provider" },
      }),
    },
  );
  assert.equal(decision, "deny");
});

test("desktop push for a room without a repository goes to its members only", async () => {
  const adHoc = { id: "team-lounge", parent_room_id: null } as Project;
  const members = new Set(["acct_member"]);
  const decide = (accountId: string) => authorizeDesktopPushNotification(
    { accountId, roomId: adHoc.id },
    {
      getProject: async () => adHoc,
      getAccount: async () => ({ ...account, account_id: accountId }),
      resolveAccess: async () => ({
        isRepoBacked: false,
        roomName: null,
        repoRoomName: null,
        binding: null,
        decision: { kind: "allow" },
      }),
      isRoomMember: async (room, id) => {
        assert.equal(room.id, adHoc.id);
        return members.has(id);
      },
    },
  );
  assert.equal(await decide("acct_member"), "allow");
  assert.equal(await decide("acct_stranger"), "deny");
});

test("desktop push for a public repository needs a GitHub role on it", async () => {
  const decision = await authorizeDesktopPushNotification(
    { accountId: account.account_id, roomId: "github.com/acme/public" },
    {
      getProject: async () => ({ id: "github.com/acme/public" }) as Project,
      getAccount: async () => account,
      resolveAccess: async () => ({
        isRepoBacked: true,
        roomName: "github.com/acme/public",
        repoRoomName: "github.com/acme/public",
        binding: null,
        decision: { kind: "repo_collaborator_required" },
      }),
      isRoomMember: async () => { throw new Error("a repo room has no member list"); },
    },
  );
  assert.equal(decision, "deny");
});
