import type { SenderIdentity } from "./types";

export function parseSenderIdentity(input: { sender?: string | null }): SenderIdentity {
  const raw = (input?.sender || "").trim();
  const parts = raw.split(" | ").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 3 && /agent$/i.test(parts[1])) {
    return {
      displayName: parts[0],
      ownerAttribution: parts[1],
      ideLabel: normalizeIdeLabel(parts[2]),
    };
  }
  return {
    displayName: raw || "Unknown",
    ownerAttribution: null,
    ideLabel: inferIdeLabel(raw),
  };
}

export function getSenderColor(sender: string, source: string | null): string {
  if (source === "github") return "#a78bfa";
  if (["system", "letagents"].includes(sender.toLowerCase())) return "#71717a";
  let hash = 5381;
  const ownerKey = parseSenderIdentity({ sender }).ownerAttribution || sender;
  for (let index = 0; index < ownerKey.length; index += 1) {
    hash = ((hash << 5) + hash + ownerKey.charCodeAt(index)) >>> 0;
  }
  const palette = ["#60a5fa", "#34d399", "#f59e0b", "#f472b6", "#a78bfa", "#fb7185", "#22d3ee"];
  return palette[hash % palette.length];
}

function normalizeIdeLabel(label: string): string | null {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "codex") return "Codex";
  if (normalized === "antigravity") return "Antigravity";
  if (normalized === "claude") return "Claude";
  if (normalized === "cursor") return "Cursor";
  if (normalized === "agent") return null;
  return normalized.split(/[^a-z0-9]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function inferIdeLabel(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("codex")) return "Codex";
  if (normalized.startsWith("antigravity")) return "Antigravity";
  if (normalized.startsWith("claude")) return "Claude";
  if (normalized.startsWith("cursor")) return "Cursor";
  return null;
}
