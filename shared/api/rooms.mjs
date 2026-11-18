// Rooms: what a page may know about the room it runs in.
import { z } from "zod";

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

export const methods = /** @type {const} */ ([getRoom]);
