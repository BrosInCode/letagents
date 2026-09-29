/**
 * Which session answers for an agent that has several live ones.
 *
 * An agent is asked once per message, through one session. Sessions of one
 * agent key overlap when a process restarts, because nothing ends the session
 * it left behind, and when two chats share an identity. Asking the oldest
 * session, as was done, hands every message after a restart to the session
 * that cannot answer: the new process polls and is told nothing was addressed
 * to it.
 *
 * So the session most likely to be there answers.
 */
export interface AnsweringSessionCandidate {
  session_id: string;
  created_at: string;
  last_seen_at: string;
}

/**
 * Sessions seen within this long of each other were seen at the same time, as
 * far as this can tell. A session is marked seen when its connection closes,
 * so a process that has just died is "seen" later than the one that replaced
 * it a moment before.
 */
const SEEN_TOGETHER_MS = 60_000;
/**
 * A session created this long after another was last seen has the signature
 * of a restart: the old process stopped, then the new one started.
 */
const RESTART_SIGNATURE_GAP_MS = 30_000;

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Negative when `left` answers before `right`. */
function compare(
  left: AnsweringSessionCandidate,
  right: AnsweringSessionCandidate,
  connectedSessionIds: ReadonlySet<string>,
): number {
  const connected = Number(connectedSessionIds.has(right.session_id))
    - Number(connectedSessionIds.has(left.session_id));
  if (connected) return connected;
  const seen = timestamp(right.last_seen_at) - timestamp(left.last_seen_at);
  if (Math.abs(seen) > SEEN_TOGETHER_MS) return seen;
  const created = timestamp(right.created_at) - timestamp(left.created_at);
  if (created) return created;
  return left.session_id < right.session_id ? -1 : left.session_id > right.session_id ? 1 : 0;
}

/**
 * A session holding a connection open answers first. Among the rest, the one
 * seen most recently; and of two seen together, the one created later.
 *
 * `connectedSessionIds` holds sessions with a connection open now. A session
 * still inside its reconnect grace is not among them: between siblings, grace
 * would let a process that has just died outrank the one that replaced it.
 */
export function chooseAnsweringSession<Session extends AnsweringSessionCandidate>(
  sessions: readonly Session[],
  connectedSessionIds: ReadonlySet<string> = new Set(),
): Session | undefined {
  // A fixed starting order, so the choice never depends on how the caller
  // happened to list them.
  const ordered = [...sessions].sort((left, right) =>
    left.session_id < right.session_id ? -1 : left.session_id > right.session_id ? 1 : 0);
  let chosen: Session | undefined;
  for (const session of ordered) {
    if (!chosen || compare(session, chosen, connectedSessionIds) < 0) chosen = session;
  }
  return chosen;
}

/**
 * A reply is meant for the session that said what is being replied to. It
 * keeps the reply while it might be there, because a sibling chat answering
 * for it is a wrong answer.
 *
 * It gives the reply up only when the agent's answering session looks like
 * its restart: this session holds no connection, and the answering one was
 * created after this one was last seen. A sibling that was already running
 * while this session was active is another chat, not a restart, and never
 * takes its replies however long this session has been quiet.
 */
export function chooseSessionForReply<Session extends AnsweringSessionCandidate>(input: {
  said: Session;
  answering: Session;
  connectedSessionIds: ReadonlySet<string>;
}): Session {
  if (input.said.session_id === input.answering.session_id) return input.said;
  if (input.connectedSessionIds.has(input.said.session_id)) return input.said;
  const restarted = timestamp(input.answering.created_at)
    >= timestamp(input.said.last_seen_at) + RESTART_SIGNATURE_GAP_MS;
  return restarted ? input.answering : input.said;
}
