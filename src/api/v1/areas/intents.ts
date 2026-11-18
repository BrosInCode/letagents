import { approveIntent, denyIntent, getIntent, intentCapability, listIntents, proposeIntent } from "../../../../shared/api/intents.mjs";
import * as service from "../../intents/service.js";
import { setApiActionTarget } from "../actions.js";
import { resolveCallPolicy } from "../capability.js";
import { defineRoute, withStatus, type ApiRoute } from "../route.js";
import { requireRoomAdminInPerson } from "./rooms.js";

// Routes for the methods in shared/api/intents.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(proposeIntent, async ({ kind, payload, clientIntentId }, call) => {
    const { intent, created } = await service.proposeIntent({
      actor: call.actor,
      room: call.room,
      account: call.account,
      kind,
      payload,
      ...(clientIntentId ? { clientIntentId } : {}),
      // The capability check read it for this call; the handler acts on the same answer.
      policy: await resolveCallPolicy(call, intentCapability({ kind })),
    });
    setApiActionTarget(call, `${intent.id} ${kind}`);
    return created ? withStatus(201, intent) : intent;
  }),
  defineRoute(getIntent, ({ intentId }, { room }) => service.getIntent(room.id, intentId)),
  defineRoute(listIntents, async (input, { room }) => ({ intents: await service.listIntents(room.id, input) })),
  defineRoute(approveIntent, async ({ intentId }, call) => {
    // A decision is a room admin's, in the app: an owner token is what MCP agents hold.
    await requireRoomAdminInPerson(call, true, "Only a room admin, signed in to LetAgents, can approve or deny intents.");
    setApiActionTarget(call, intentId);
    return service.approveIntent({ room: call.room, intentId, adminAccountId: call.account!.account_id });
  }),
  defineRoute(denyIntent, async ({ intentId, reason }, call) => {
    await requireRoomAdminInPerson(call, true, "Only a room admin, signed in to LetAgents, can approve or deny intents.");
    setApiActionTarget(call, intentId);
    return service.denyIntent({ room: call.room, intentId, adminAccountId: call.account!.account_id, ...(reason ? { reason } : {}) });
  }),
];
