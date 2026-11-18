// The one registry of LetAgents API capabilities. A page manifest asks for
// these names, a room admin grants them, and every /api/v1 route checks one.
// The label is what the grant sheet shows, so it is plain words for a person,
// not for a developer.

/** What a room does when a capability is used, before any room admin changes it. */
export const CAPABILITY_POLICIES = /** @type {const} */ (["allow", "confirm", "approve", "deny"]);

/**
 * A rule that can relax the default policy at run time:
 * - `board_manager_mode`: allowed while the room's Board Manager is off; a
 *   board intent while `shouldRequireBoardIntent` is true.
 * - `own_tracker_connection`: allowed when the viewer's own tracker
 *   connection runs the change; otherwise a room admin approves.
 */
export const CAPABILITY_POLICY_RULES = /** @type {const} */ (["board_manager_mode", "own_tracker_connection"]);

/**
 * @typedef {typeof CAPABILITY_POLICIES[number]} CapabilityPolicy
 * @typedef {typeof CAPABILITY_POLICY_RULES[number]} CapabilityPolicyRule
 * @typedef {{
 *   readonly label: string,
 *   readonly defaultPolicy: CapabilityPolicy,
 *   readonly policyRule: CapabilityPolicyRule | null,
 *   readonly writeLike: boolean,
 * }} CapabilitySpec
 */

/**
 * `writeLike` marks capabilities that act for the viewer (posts, jobs,
 * proposals). A new page version that holds one waits for a room admin when
 * a non-admin made it.
 */
export const CAPABILITIES = Object.freeze({
  "rooms.read": spec("See this room's name, kind and repository", "allow"),
  "people.read": spec("See the people in this room and their roles", "allow"),
  "agents.read": spec("See the agents in this room and whether they are online", "allow"),
  "messages.read": spec("Read messages in this room", "allow"),
  "tasks.read": spec("See the board tasks in this room", "allow"),
  "planning.read": spec("See sprints, the release queue and the board plan", "allow"),
  "work_items.read": spec("Read tickets from this room's trackers", "allow"),
  "git.read": spec("See pull requests, checks and reviews for this room's repository", "allow"),
  "memory.read": spec("Read the facts this room remembers", "allow"),
  "data.viewer": spec("Keep your own settings for this page", "allow"),
  "data.page": spec("Keep data that everyone using this page shares", "allow"),
  "data.room": spec("Read and change data that all pages and agents in this room share", "allow"),
  "tasks.propose": spec("Propose new board tasks and changes to tasks", "approve", "board_manager_mode", true),
  "tickets.propose": spec("Propose ticket status changes and comments", "approve", "own_tracker_connection", true),
  "jobs.start": spec("Ask an agent in this room to do work for you", "confirm", null, true),
  "messages.post": spec("Post messages in this room for you", "confirm", null, true),
});

/** @typedef {keyof typeof CAPABILITIES} CapabilityName */

/** @type {readonly CapabilityName[]} */
export const CAPABILITY_NAMES = Object.freeze(/** @type {CapabilityName[]} */ (Object.keys(CAPABILITIES)));

/**
 * @param {unknown} value
 * @returns {value is CapabilityName}
 */
export function isCapabilityName(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CAPABILITIES, value);
}

/**
 * @param {CapabilityName} name
 * @returns {CapabilitySpec}
 */
export function getCapability(name) {
  return CAPABILITIES[name];
}

/**
 * @param {string} label
 * @param {CapabilityPolicy} defaultPolicy
 * @param {CapabilityPolicyRule | null} [policyRule]
 * @param {boolean} [writeLike]
 * @returns {CapabilitySpec}
 */
function spec(label, defaultPolicy, policyRule = null, writeLike = false) {
  return Object.freeze({ label, defaultPolicy, policyRule, writeLike });
}
