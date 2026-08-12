import { databaseSkipReason, dbApi } from "./database.js";
import { hashToken } from "../../db/utils.js";

export type CoordinationTestActor = {
  actor_label: string;
  actor_key: string;
  actor_instance_id: string;
  display_name: string;
};

export const bayActor: CoordinationTestActor = {
  actor_label: "BayOtter | Emmy May's agent | Agent",
  actor_key: "EmmyMay/bayotter",
  actor_instance_id: "instance:bayotter-1",
  display_name: "BayOtter",
};

export const dawnActor: CoordinationTestActor = {
  actor_label: "DawnWinter | Emmy May's agent | Agent",
  actor_key: "EmmyMay/dawnwinter",
  actor_instance_id: "instance:dawn-1",
  display_name: "DawnWinter",
};

export async function createWorkerSessionCredentials(input: {
  roomId: string;
  ownerAccountId: string;
  ownerLabel: string;
  actor: CoordinationTestActor;
}): Promise<{ agent_session_id: string; agent_session_token: string }> {
  const { createRoomAgentSession, markRoomAgentDeliveryConnected } = dbApi;
  if (!createRoomAgentSession) {
    throw new Error(`DB-backed coordination tests require ${databaseSkipReason}`);
  }

  const session = await createRoomAgentSession({
    room_id: input.roomId,
    session_kind: "worker",
    runtime: "codex",
    actor_label: input.actor.actor_label,
    agent_key: input.actor.actor_key,
    agent_instance_id: input.actor.actor_instance_id,
    display_name: input.actor.display_name,
    owner_account_id: input.ownerAccountId,
    owner_label: input.ownerLabel,
    ide_label: "Codex",
  });
  await markRoomAgentDeliveryConnected?.({
    room_id: input.roomId,
    actor_label: session.actor_label,
    agent_key: session.agent_key,
    agent_instance_id: session.agent_instance_id,
    agent_session_id: session.session_id,
    session_kind: session.session_kind,
    runtime: session.runtime,
    display_name: session.display_name,
    owner_label: session.owner_label,
    ide_label: session.ide_label,
    credential_fence: {
      kind: "session_token",
      token_hash: hashToken(session.session_token),
    },
    transport: "long_poll",
  });

  return {
    agent_session_id: session.session_id,
    agent_session_token: session.session_token,
  };
}

export async function createOwnerAuth(input: {
  githubUserId: string;
  token: string;
}) {
  const {
    createOwnerToken,
    registerAgentIdentity,
    upsertAccount,
  } = dbApi;
  if (!createOwnerToken || !registerAgentIdentity || !upsertAccount) {
    throw new Error(`DB-backed coordination tests require ${databaseSkipReason}`);
  }

  const owner = await upsertAccount({
    provider: "github",
    provider_user_id: input.githubUserId,
    login: "EmmyMay",
    display_name: "Emmy May",
  });
  await createOwnerToken({
    accountId: owner.id,
    githubUserId: owner.provider_user_id,
    token: input.token,
    providerAccessToken: "github-token",
  });
  await registerAgentIdentity({
    owner_account_id: owner.id,
    owner_login: owner.login,
    owner_label: owner.display_name ?? owner.login,
    name: "bayotter",
    display_name: "BayOtter",
  });
  await registerAgentIdentity({
    owner_account_id: owner.id,
    owner_login: owner.login,
    owner_label: owner.display_name ?? owner.login,
    name: "dawnwinter",
    display_name: "DawnWinter",
  });

  return {
    owner,
    ownerLabel: owner.display_name ?? owner.login,
    ownerToken: input.token,
  };
}

export async function createWorkerPair(input: {
  roomId: string;
  ownerAccountId: string;
  ownerLabel: string;
}) {
  const bayCredentials = await createWorkerSessionCredentials({
    roomId: input.roomId,
    ownerAccountId: input.ownerAccountId,
    ownerLabel: input.ownerLabel,
    actor: bayActor,
  });
  const dawnCredentials = await createWorkerSessionCredentials({
    roomId: input.roomId,
    ownerAccountId: input.ownerAccountId,
    ownerLabel: input.ownerLabel,
    actor: dawnActor,
  });

  return { bayCredentials, dawnCredentials };
}
