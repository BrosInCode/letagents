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
