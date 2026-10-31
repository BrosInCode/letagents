import type { InjectionKey, Ref } from "vue";
import {
  attentionResponseDisplayText,
  attentionResponseHandle,
} from "../../../../../shared/room-knowledge.mjs";

/** Room agents' names keyed by the handle a Needs-you answer uses to wake them. */
export function attentionResponseAgentNames(
  people: Iterable<{ agentKey: string | null; displayName: string | null }>,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const person of people) {
    const handle = attentionResponseHandle(person.agentKey);
    const name = person.displayName?.split("|")[0]?.trim();
    if (handle && name && !names.has(handle)) names.set(handle, name);
  }
  return names;
}

export const attentionResponseAgentNamesKey: InjectionKey<Readonly<Ref<ReadonlyMap<string, string>>>> =
  Symbol("attention-response-agent-names");

/**
 * The text people see for a room message. A person's Needs-you answer carries
 * the asking agent's handle and the request id for that agent's routing; the
 * room reads it as a reply to the agent by name instead.
 */
export function roomMessageVisibleText(
  message: { text: string; displayText?: string | null; source?: string | null },
  agentNames: ReadonlyMap<string, string> | null | undefined,
): string {
  if (message.displayText) return message.displayText;
  if (message.source === "browser") {
    const answer = attentionResponseDisplayText(message.text, (handle) => agentNames?.get(handle));
    if (answer !== null) return answer;
  }
  return message.text;
}
