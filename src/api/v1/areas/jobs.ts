import { cancelJob as cancelJobMethod, getJob as getJobMethod, listJobs as listJobsMethod, startJob as startJobMethod } from "../../../../shared/api/jobs.mjs";
import { cancelJob, getJob, listJobs, startJob } from "../../jobs/service.js";
import { decideRoomAdmin, roomAccessPrincipal } from "../../rooms/access-decision.js";
import { defineRoute, type ApiRoute } from "../route.js";

// Routes for the methods in shared/api/jobs.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(startJobMethod, (input, { room, actor, account }) => startJob({
    roomId: room.id,
    actor,
    senderLabel: account?.login ?? actor.principal.login ?? actor.principal.id,
    agent: input.agent,
    instruction: input.instruction,
    input: input.input,
    resultSchema: input.resultSchema,
  })),
  defineRoute(getJobMethod, ({ id }, { room }) => getJob(room.id, id)),
  defineRoute(listJobsMethod, async ({ state, limit }, { room }) => ({ jobs: await listJobs(room.id, { state, limit }) })),
  defineRoute(cancelJobMethod, ({ id }, { room, access, actor, account }) => cancelJob({
    roomId: room.id,
    id,
    actor,
    // A stored admin row decides when GitHub does not answer: cancelling stops work, it grants nothing.
    isRoomAdmin: async () => Boolean(account) && (await decideRoomAdmin({
      project: room, principal: roomAccessPrincipal(account), target: access, outage: "stored_row",
    })).role === "admin",
  })),
];
