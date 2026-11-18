import { ApiError } from "../../../../shared/api/core.mjs";
import { getViewer, listPeople, type Person } from "../../../../shared/api/people.mjs";
import { getRoomParticipants } from "../../db.js";
import { listRoomMembers } from "../../db/room-members.js";
import { decideRoomAdmin, roomAccessPrincipal } from "../../rooms/access-decision.js";
import { defineRoute, type ApiRoute } from "../route.js";

// Routes for the methods in shared/api/people.mjs, made with defineRoute.
export const routes: readonly ApiRoute[] = [
  defineRoute(listPeople, async (_input, { room, access }) => {
    if (access.kind === "membership") {
      const members = await listRoomMembers(access.accessRoomId);
      return {
        managedBy: "letagents" as const,
        people: members.map((member) => toPerson(member.login, member.display_name, member.avatar_url, member.role === "admin")),
      };
    }
    // GitHub decides who may open a repository room, and asking it for every
    // collaborator is not cheap. What LetAgents knows is the room's stored
    // admin rows (not checked against GitHub again here) and the people the
    // room has seen.
    const [stored, participants] = await Promise.all([
      listRoomMembers(access.accessRoomId),
      getRoomParticipants(room.id, { limit: 200 }),
    ]);
    const people = new Map<string, Person>();
    for (const member of stored) people.set(member.login.toLowerCase(), toPerson(member.login, member.display_name, member.avatar_url, member.role === "admin"));
    for (const participant of participants) {
      const login = participant.kind === "human" ? participant.github_login : null;
      if (login && !people.has(login.toLowerCase())) people.set(login.toLowerCase(), toPerson(login, null, null, false));
    }
    return {
      managedBy: "github" as const,
      people: [...people.values()].sort((a, b) => Number(b.role === "admin") - Number(a.role === "admin")),
    };
  }),
  defineRoute(getViewer, async (_input, { room, access, account }) => {
    if (!account) throw new ApiError("unauthenticated", "Sign in to LetAgents to use the API.");
    // The one admin decision the room routes use: a focus room's own admin
    // row, or GitHub's answer in a repository room.
    const decision = await decideRoomAdmin({ project: room, principal: roomAccessPrincipal(account), target: access });
    return toPerson(account.login, account.display_name, account.avatar_url, decision.role === "admin");
  }),
];

function toPerson(login: string, name: string | null, avatarUrl: string | null, admin: boolean): Person {
  return { login, name, avatarUrl, role: admin ? "admin" : "participant" };
}

