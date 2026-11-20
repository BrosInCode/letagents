import type { SenderIdentity } from "./types";
import { ownerAttributionFromOwnerLabel, parseAgentLabel } from "../../../../../../../../shared/ui/agent-label";

export { getSenderColor } from "../../../../../../../../shared/ui/sender-color";

/** The shared agent-label parser, with the desktop's display choices. */
export function parseSenderIdentity(input: { sender?: string | null }): SenderIdentity {
  const label = parseAgentLabel(input?.sender);
  return {
    displayName: label.displayName || "Unknown",
    ownerAttribution: label.ownerAttribution,
    // "Agent" is the generic fallback, not a provider worth showing.
    ideLabel: label.ideLabel === "Agent" ? null : label.ideLabel,
  };
}

export function resolveOwnerAttribution(input: {
  ownerAttribution?: string | null;
  ownerLabel?: string | null;
  actorLabel?: string | null;
  sender?: string | null;
}): string | null {
  return input.ownerAttribution?.trim()
    || ownerAttributionFromOwnerLabel(input.ownerLabel)
    || parseSenderIdentity({ sender: input.actorLabel }).ownerAttribution
    || parseSenderIdentity({ sender: input.sender }).ownerAttribution;
}
