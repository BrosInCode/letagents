import { roomAccessToolResponse } from "../../runtime/room-access.js";

export function jsonToolResponse(value: unknown, space?: number) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, space),
      },
    ],
  };
}

/** A failed tool call. Sign-in and members-only refusals keep their own result. */
export function taskToolError(error: unknown) {
  return roomAccessToolResponse(error)
    ?? jsonToolResponse({ success: false, error: typeof error === "string" ? error : String(error) });
}
