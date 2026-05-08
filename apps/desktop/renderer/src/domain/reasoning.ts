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

export function reasoningFieldRows(session: DesktopReasoningSession): Array<{ label: string; value: string }> {
  const payload = session.latestPayload;
  const rows = [
    { label: "Goal", value: payload?.goal || session.goal || "" },
    { label: "Checking", value: payload?.checking || session.checking || "" },
    { label: "Hypothesis", value: payload?.hypothesis || session.hypothesis || "" },
    { label: "Next", value: payload?.next_action || session.nextAction || "" },
    { label: "Blocker", value: payload?.blocker || session.blocker || "" },
    {
      label: "Confidence",
      value: typeof payload?.confidence === "number"
        ? `${Math.round(payload.confidence * 100)}%`
        : typeof session.confidence === "number"
          ? `${Math.round(session.confidence * 100)}%`
          : "",
    },
  ];
  return rows.filter((row) => row.value.trim()).slice(0, 4);
}

export function reasoningStatus(session: DesktopReasoningSession): string {
  if (session.closedAt) return "Closed";
  const status = String(session.latestPayload?.status || session.status || "active").trim();
  return status
    ? status.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())
    : "Active";
}
