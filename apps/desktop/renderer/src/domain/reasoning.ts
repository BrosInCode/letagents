import type { DesktopReasoningSession } from "../../../electron/ipc-types";

export function reasoningTitle(session: DesktopReasoningSession): string {
  return session.title || session.latestPayload?.goal || session.summary || session.goal || "Thinking";
}

export function reasoningSummary(session: DesktopReasoningSession): string {
  return session.latestPayload?.summary
    || session.latestPayload?.checking
    || session.latestPayload?.next_action
    || session.latestPayload?.hypothesis
    || session.summary
    || session.checking
    || session.nextAction
    || session.hypothesis
    || "No summary exposed yet.";
}
