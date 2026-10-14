import type { ConversationPerson } from "../../../../../shared/conversation-contracts.d.mts";
import type { PersonTarget } from "./person-target";
import { safeUserVisibleErrorDetail } from "./user-visible-error";

export const OPEN_CONVERSATION_FAILED_MESSAGE = "LetAgents could not open that conversation.";

export type OpenConversationWithPersonResult =
  | { status: "self" }
  | { status: "not_found" }
  | { status: "failed"; message: string }
  | { status: "opened"; conversationId: string };

/**
 * Find the LetAgents account for a GitHub login, then open a private
 * conversation with it. The api functions are passed in so this runs
 * without IPC. Errors from the api are returned, not thrown.
 */
export async function openConversationWithPerson(
  target: PersonTarget,
  viewerLogin: string | null,
  api: {
    people(query: string): Promise<{ people: ConversationPerson[] }>;
    create(accountIds: string[]): Promise<{ conversation_id: string }>;
  },
): Promise<OpenConversationWithPersonResult> {
  const wanted = target.login.trim().toLowerCase();
  const viewer = (viewerLogin ?? "").trim().toLowerCase();
  if (viewer && wanted === viewer) return { status: "self" };
  // The people search cannot return logins this short, so do not ask it.
  if (wanted.length < 2) return { status: "not_found" };
  try {
    const { people } = await api.people(target.login);
    const person = people.find((candidate) => candidate.login.trim().toLowerCase() === wanted);
    if (!person) return { status: "not_found" };
    const result = await api.create([person.id]);
    return { status: "opened", conversationId: result.conversation_id };
  } catch (error) {
    return { status: "failed", message: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  const message: unknown = (error as { message?: unknown } | null)?.message;
  if (typeof message !== "string" || !message.trim()) return OPEN_CONVERSATION_FAILED_MESSAGE;
  return safeUserVisibleErrorDetail(message, OPEN_CONVERSATION_FAILED_MESSAGE);
}
