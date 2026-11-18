// Rooms: what a page may know about the room it runs in.
import { z } from "zod";

import { CAPABILITY_NAMES, CAPABILITY_POLICIES, CAPABILITY_POLICY_RULES } from "./capabilities.mjs";
import { defineMethod } from "./core.mjs";

export const RoomRepo = z.object({
  provider: z.enum(["github"]),
  host: z.string(),
  owner: z.string(),
  name: z.string(),
  /** `owner/name` */
  fullName: z.string(),
  url: z.string(),
  /** The branch, tag or pull request the room follows; null when the room is not bound to one yet. */
  ref: z
    .object({
      type: z.enum(["default_branch", "branch", "tag", "pull_request"]),
      name: z.string().nullable(),
    })
    .nullable(),
});

/**
 * `members`: only the room's members can open it. `public`, `private`,
 * `unknown`: a repository room, open to whoever GitHub lets read the
 * repository; the value is the repository's visibility.
 */
export const ROOM_VISIBILITIES = /** @type {const} */ (["members", "public", "private", "unknown"]);

export const RoomSummary = z.object({
  id: z.string(),
  name: z.string(),
  /** `focus` is a side room made from a task in a parent room. */
  kind: z.enum(["main", "focus"]),
  parentRoomId: z.string().nullable(),
  repo: RoomRepo.nullable(),
  visibility: z.enum(ROOM_VISIBILITIES),
});

/** @typedef {z.infer<typeof RoomRepo>} RoomRepo */
/** @typedef {z.infer<typeof RoomSummary>} RoomSummary */

export const getRoom = defineMethod({
  name: "rooms.get",
  area: "rooms",
  kind: "read",
  capability: "rooms.read",
  description:
    "The room the caller is in: its id, display name, kind (main or focus), the repository it follows, and who can open it.",
  path: "/rooms/:room",
  input: z.strictObject({}),
  output: RoomSummary,
  errors: ["not_found"],
  rateClass: "read",
});

/**
 * Capabilities with a room policy: everything but reads, which every room
 * participant may use in `api: 1`.
 */
export const POLICY_CAPABILITY_NAMES = CAPABILITY_NAMES.filter((name) => !name.endsWith(".read"));

export const RoomApiPolicy = z.object({
  capability: z.string(),
  /** What happens when the capability is used: `confirm` asks the viewer, `approve` waits for a room admin. */
  mode: z.enum(CAPABILITY_POLICIES),
  /** `room` when a room admin chose the mode, `default` when it is the LetAgents default. */
  source: z.enum(["room", "default"]),
  /** A rule that relaxes a default at run time (Board Manager mode, the viewer's own tracker connection). */
  rule: z.enum(CAPABILITY_POLICY_RULES).nullable(),
});

export const RoomApiPolicies = z.object({ policies: z.array(RoomApiPolicy) });

/** @typedef {z.infer<typeof RoomApiPolicy>} RoomApiPolicy */
/** @typedef {z.infer<typeof RoomApiPolicies>} RoomApiPolicies */

export const listRoomPolicies = defineMethod({
  name: "rooms.listPolicies",
  area: "rooms",
  kind: "read",
  capability: "rooms.read",
  description:
    "The room's API policy for each capability that is not a read: allow, confirm (the viewer confirms in the app), approve (a room admin approves) or deny. Room admins only, signed in as themselves; pages and agents get not_granted.",
  path: "/rooms/:room/policies",
  input: z.strictObject({}),
  output: RoomApiPolicies,
  rateClass: "read",
});

export const setRoomPolicy = defineMethod({
  name: "rooms.setPolicy",
  area: "rooms",
  kind: "write",
  httpMethod: "PUT",
  capability: "rooms.read",
  description:
    "Sets the room's API policy for one capability; mode null goes back to the LetAgents default. Returns every policy. Room admins only, in the LetAgents app; pages, agents and owner tokens get not_granted.",
  path: "/rooms/:room/policies",
  input: z.strictObject({
    capability: z.enum(POLICY_CAPABILITY_NAMES),
    mode: z.enum(CAPABILITY_POLICIES).nullable(),
  }),
  output: RoomApiPolicies,
  rateClass: "write",
});

export const methods = /** @type {const} */ ([getRoom, listRoomPolicies, setRoomPolicy]);
