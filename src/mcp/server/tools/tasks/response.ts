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

export function taskToolError(error: string) {
  return jsonToolResponse({ success: false, error });
}
