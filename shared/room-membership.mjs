// Who may read a room, post in it and so wake its agents. The server and every
// client read the refusals from this one file, so a refusal looks the same in
// the web app, the desktop app and the MCP client.
//
// A room that is not tied to a repository has members: its creator, people a
// room admin let in, and the people with proof from before members existed. A
// room tied to a GitHub repository has no member list: the GitHub role decides.
// A focus room always uses the members of its parent room.

/** 403: signed in, but not a member of a room that is not tied to a repository. */
export const ROOM_MEMBERSHIP_REQUIRED = Object.freeze({
  error: 'room_membership_required',
  code: 'ROOM_MEMBERSHIP_REQUIRED',
});

/** 403: signed in, but with no GitHub role on the public repository of the room. */
export const REPO_COLLABORATOR_REQUIRED = Object.freeze({
  error: 'repo_collaborator_required',
  code: 'REPO_COLLABORATOR_REQUIRED',
});

/** 503: GitHub gave no answer to a repository role check. Not a refusal: retry. */
export const REPO_ACCESS_UNAVAILABLE = Object.freeze({
  error: 'repo_access_unavailable',
  code: 'REPO_ACCESS_UNAVAILABLE',
});

/** 400: a join request names a focus room; a person asks to join the main room. */
export const ROOM_JOIN_REQUEST_MAIN_ROOM_ONLY = Object.freeze({
  error: 'Ask to join the main room, not one of its focus rooms.',
  code: 'ROOM_JOIN_REQUEST_MAIN_ROOM_ONLY',
});

/** 409: a member route was called for a room whose access the GitHub role decides. */
export const REPO_ROOM_USES_GITHUB_ROLES = Object.freeze({
  error: 'repo_room_uses_github_roles',
  code: 'REPO_ROOM_USES_GITHUB_ROLES',
});

export const ROOM_MEMBERSHIP_REQUIRED_MESSAGE =
  'Only members can open this room. Ask to join, and a room admin can let you in.';
export const REPO_COLLABORATOR_REQUIRED_MESSAGE =
  'Only people with a role on this GitHub repository can open its room. Ask a repository admin to add you on GitHub.';
export const REPO_ACCESS_UNAVAILABLE_MESSAGE =
  'GitHub did not answer the repository access check. Please retry.';
export const REPO_ROOM_USES_GITHUB_ROLES_MESSAGE =
  'Repo rooms use GitHub roles. Ask a repository admin to add the person on GitHub.';

export const ROOM_MEMBER_ROLES = Object.freeze(['admin', 'member']);
export const ROOM_MEMBER_SOURCES = Object.freeze(['creator', 'seed', 'approved_request']);
export const ROOM_JOIN_REQUEST_STATES = Object.freeze(['pending', 'approved', 'declined', 'cancelled']);

/** After a decline, the same person can ask the same room again after this wait. */
export const ROOM_JOIN_REQUEST_DECLINE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * The 403 body for a signed-in person who is not a member. `join_request` is
 * that person's latest request for the room, so a client can show "Ask to
 * join", "Waiting for an admin" or "Declined" without a second call.
 */
export function roomMembershipRequiredBody({ room_id, display_name, join_request }) {
  return {
    ...ROOM_MEMBERSHIP_REQUIRED,
    message: ROOM_MEMBERSHIP_REQUIRED_MESSAGE,
    room_id,
    display_name: display_name ?? null,
    join_request: join_request ?? null,
  };
}

export function repoCollaboratorRequiredBody({ room_id }) {
  return {
    ...REPO_COLLABORATOR_REQUIRED,
    message: REPO_COLLABORATOR_REQUIRED_MESSAGE,
    room_id,
  };
}

/**
 * Reads an error body and says which membership refusal it is, if any.
 * Returns 'membership_required', 'repo_collaborator_required' or null.
 */
export function roomAccessRefusal(body) {
  if (!body || typeof body !== 'object') return null;
  const { error, code } = body;
  if (code === ROOM_MEMBERSHIP_REQUIRED.code || error === ROOM_MEMBERSHIP_REQUIRED.error) {
    return 'membership_required';
  }
  if (code === REPO_COLLABORATOR_REQUIRED.code || error === REPO_COLLABORATOR_REQUIRED.error) {
    return 'repo_collaborator_required';
  }
  return null;
}
