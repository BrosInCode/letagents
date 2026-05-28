export function jsonToolResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function missingRoomResponse() {
  return jsonToolResponse({
    success: false,
    error: "No room_id provided and not currently in a room.",
    hint: "Join or create a room first, or pass room_id explicitly.",
  });
}
