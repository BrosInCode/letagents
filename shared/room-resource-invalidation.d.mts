export const ROOM_RESOURCE_INVALIDATION_CAPABILITY: "resource_invalidation_v1";
export const ROOM_RESOURCE_AGENT_WORK: "agent_work";
/** Content-free approval-state hint; consumers repair through separately authorized exact reads. */
export const ROOM_RESOURCE_AGENT_APPROVAL: "agent_approval";
export const ROOM_RESOURCE_EXECUTION_DELEGATION: "execution_delegation";
/** Protocol-known references; consumers independently choose what they render. */
export const ROOM_RESOURCE_INVALIDATION_RESOURCES: readonly [
  "agent_work",
  "agent_approval",
  "execution_delegation",
];

export type RoomResourceInvalidationResource =
  typeof ROOM_RESOURCE_INVALIDATION_RESOURCES[number];

export type RoomResourceInvalidationPointer<Resource extends string = string> = {
  room_id: string;
  resource: Resource;
};

export type RoomResourceInvalidationParseResult =
  | {
      status: "supported";
      pointer: RoomResourceInvalidationPointer<RoomResourceInvalidationResource>;
    }
  | {
      status: "unsupported";
      pointer: RoomResourceInvalidationPointer;
    }
  | { status: "malformed" };

/**
 * Parse a bounded room-resource pointer without echoing malformed input.
 * Unknown but well-formed resources remain forward-compatible cursor no-ops.
 */
export function parseRoomResourceInvalidation(
  value: unknown,
): RoomResourceInvalidationParseResult;
