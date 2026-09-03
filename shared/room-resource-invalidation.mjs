export const ROOM_RESOURCE_INVALIDATION_CAPABILITY = "resource_invalidation_v1";
export const ROOM_RESOURCE_AGENT_WORK = "agent_work";
export const ROOM_RESOURCE_AGENT_APPROVAL = "agent_approval";
export const ROOM_RESOURCE_EXECUTION_DELEGATION = "execution_delegation";
// Protocol-known references. Each consumer still decides which surfaces, if
// any, react to a supported pointer.
export const ROOM_RESOURCE_INVALIDATION_RESOURCES = [
  ROOM_RESOURCE_AGENT_WORK,
  ROOM_RESOURCE_AGENT_APPROVAL,
  ROOM_RESOURCE_EXECUTION_DELEGATION,
];

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isValidRoomIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isValidResource(value) {
  return typeof value === "string"
    && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

/**
 * Parse a bounded room-resource pointer without echoing malformed input.
 * Unknown but well-formed resources remain forward-compatible cursor no-ops.
 */
export function parseRoomResourceInvalidation(value) {
  if (
    !exactKeys(value, ["room_id", "resource"])
    || !isValidRoomIdentifier(value.room_id)
    || !isValidResource(value.resource)
  ) return { status: "malformed" };

  const pointer = { room_id: value.room_id, resource: value.resource };
  return ROOM_RESOURCE_INVALIDATION_RESOURCES.includes(value.resource)
    ? { status: "supported", pointer }
    : { status: "unsupported", pointer };
}
