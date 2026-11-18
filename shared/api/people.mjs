// People: members of the room with their role, and the viewer.
import { z } from "zod";

import { defineMethod } from "./core.mjs";

export const PERSON_ROLES = /** @type {const} */ (["admin", "participant"]);

export const Person = z.object({
  /** GitHub login. */
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: z.enum(PERSON_ROLES),
});

/**
 * `letagents`: the room's member list decides who may open it, and `people`
 * is that list. `github`: the repository decides, so nobody can list every
 * person who may open the room; `people` holds the people the room has seen,
 * each as `participant`.
 */
export const PeopleList = z.object({
  managedBy: z.enum(["letagents", "github"]),
  people: z.array(Person),
});

/** @typedef {z.infer<typeof Person>} Person */
/** @typedef {z.infer<typeof PeopleList>} PeopleList */

export const listPeople = defineMethod({
  name: "people.list",
  area: "people",
  kind: "read",
  capability: "people.read",
  description:
    "The people in the room with their role (admin or participant), admins first. In a repository room GitHub decides who may open it, so the list holds the people the room has seen, all as participants, and `managedBy` is `github`.",
  path: "/rooms/:room/people",
  input: z.strictObject({}),
  output: PeopleList,
  rateClass: "read",
});

export const getViewer = defineMethod({
  name: "people.viewer",
  area: "people",
  kind: "read",
  capability: "people.read",
  description: "The person using the page or app: their GitHub login, name, avatar and role in this room.",
  path: "/rooms/:room/people/me",
  input: z.strictObject({}),
  output: Person,
  rateClass: "read",
});

export const methods = /** @type {const} */ ([listPeople, getViewer]);
