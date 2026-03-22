const STRUCTURED_AGENT_LABEL_SEPARATOR = " | ";

const IDE_LABELS = new Map<string, string>([
  ["agent", "Agent"],
  ["antigravity", "Antigravity"],
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["orchestrator", "Orchestrator"],
]);

export interface ParsedAgentActorLabel {
  raw: string;
  display_name: string;
  owner_attribution: string | null;
  ide_label: string | null;
  structured: boolean;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeIdeLabel(value: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(String(value ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    return null;
  }

  return IDE_LABELS.get(normalized) ?? toTitleCaseCodename(normalized);
}

export function toTitleCaseCodename(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "";
  }

  return normalized
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function formatOwnerAttribution(ownerLabel: string): string {
  const trimmed = normalizeWhitespace(ownerLabel) || "Owner";
  return /s$/i.test(trimmed) ? `${trimmed}' agent` : `${trimmed}'s agent`;
}

export function inferAgentIdeLabel(value: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(String(value ?? "")).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "codex" || normalized.startsWith("codex-")) {
    return "Codex";
  }

  if (normalized === "antigravity" || normalized.startsWith("antigravity-")) {
    return "Antigravity";
  }

  if (normalized === "claude" || normalized.startsWith("claude-")) {
    return "Claude";
  }

  if (normalized === "orchestrator" || normalized.startsWith("orchestrator-")) {
    return "Orchestrator";
  }

  return null;
}

export function buildAgentActorLabel(input: {
  display_name: string;
  owner_label: string;
  ide_label?: string | null;
}): string {
  const displayName = normalizeWhitespace(input.display_name) || "Agent";
  const ownerAttribution = formatOwnerAttribution(input.owner_label);
  const ideLabel = normalizeIdeLabel(input.ide_label) ?? "Agent";
  return [displayName, ownerAttribution, ideLabel].join(STRUCTURED_AGENT_LABEL_SEPARATOR);
}

export function parseAgentActorLabel(
  value: string | null | undefined
): ParsedAgentActorLabel | null {
  const raw = normalizeWhitespace(String(value ?? ""));
  if (!raw) {
    return null;
  }

  const structuredParts = raw
    .split(STRUCTURED_AGENT_LABEL_SEPARATOR)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
  if (
    structuredParts.length === 3 &&
    /agent$/i.test(structuredParts[1]) &&
    normalizeIdeLabel(structuredParts[2])
  ) {
    return {
      raw,
      display_name: structuredParts[0],
      owner_attribution: structuredParts[1],
      ide_label: normalizeIdeLabel(structuredParts[2]),
      structured: true,
    };
  }

  const legacyMatch = raw.match(/^(.*?)\s*\(([^)]+agent)\)$/i);
  if (legacyMatch) {
    const displayName = normalizeWhitespace(legacyMatch[1] ?? "") || raw;
    const ownerAttribution = normalizeWhitespace(legacyMatch[2] ?? "") || null;
    return {
      raw,
      display_name: displayName,
      owner_attribution: ownerAttribution,
      ide_label: inferAgentIdeLabel(displayName),
      structured: false,
    };
  }

  return {
    raw,
    display_name: raw,
    owner_attribution: null,
    ide_label: inferAgentIdeLabel(raw),
    structured: false,
  };
}

export function getAgentPrimaryLabel(value: string | null | undefined): string {
  return parseAgentActorLabel(value)?.display_name ?? normalizeWhitespace(String(value ?? ""));
}
