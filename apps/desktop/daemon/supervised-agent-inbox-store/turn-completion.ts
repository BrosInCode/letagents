import type { StructuredRoomTurnCompletion } from "./types.js";

/** Validate the durable request written by the supervised-only completion tool. */
export function structuredRoomTurnCompletion(value: unknown): StructuredRoomTurnCompletion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "outcome" && key !== "text")) return null;
  if (record.outcome === "no_reply") {
    return record.text === undefined || record.text === null || record.text === ""
      ? { outcome: "no_reply", text: null }
      : null;
  }
  if (record.outcome !== "reply" || typeof record.text !== "string") return null;
  const text = record.text.trim();
  if (!text || Buffer.byteLength(text, "utf8") > 32 * 1024) return null;
  return { outcome: "reply", text };
}

export function structuredRoomTurnCompletionResult(completion: StructuredRoomTurnCompletion): Record<string, unknown> {
  const payload = {
    accepted: true,
    outcome: completion.outcome,
    instruction: "The daemon recorded this exact turn completion. End the provider turn without sending the activating reply through another tool.",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}
