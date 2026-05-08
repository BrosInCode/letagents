export function normalizeAgentKey(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

export function displayNameFromActor(actorLabel: string | null | undefined): string {
  const parts = actorParts(actorLabel);
  return parts[0] || String(actorLabel || "").trim() || "Agent";
}

export function ownerFromActor(actorLabel: string | null | undefined): string | null {
  return actorParts(actorLabel)[1]?.replace(/'s agent$/i, "") || null;
}

export function ideFromActor(actorLabel: string | null | undefined): string | null {
  return actorParts(actorLabel)[2] || null;
}

function actorParts(actorLabel: string | null | undefined): string[] {
  return String(actorLabel || "").split("|").map((part) => part.trim()).filter(Boolean);
}
