export interface AgentRosterRow {
  id: string;
  name: string;
  provider: string;
  model?: string | null;
  owner: string;
  state: string;
  detail: string;
  tone: "green" | "blue" | "amber" | "violet" | "red" | "neutral";
  working: boolean;
  attention: boolean;
  moving: boolean;
}
export interface AgentHistoryPerson {
  id: string;
  name: string;
  kind: "agent" | "human";
  provider: string;
  owner: string;
  room: string;
  branch?: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  past: boolean;
}
export interface AgentHistoryWork {
  id: string;
  title: string;
  people: string[];
  byline: string;
  state: string;
  time: string | null;
  detail?: string;
  links: ReadonlyArray<{ label: string; url: string }>;
}
export function historyTime(value: string | null): string {
  if (!value) return "Not recorded";
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? "Not recorded"
    : time.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
/** Preserve one work record when several participants created or worked on it. */
export function mergeHistoryWork(
  records: AgentHistoryWork[],
): AgentHistoryWork[] {
  const unique = new Map<string, AgentHistoryWork>();
  for (const record of records) {
    const previous = unique.get(record.id);
    unique.set(
      record.id,
      previous
        ? {
            ...previous,
            people: [...new Set([...previous.people, ...record.people])],
          }
        : record,
    );
  }
  return [...unique.values()].sort(
    (a, b) => (Date.parse(b.time || "") || 0) - (Date.parse(a.time || "") || 0),
  );
}

export function agentProviderLabel(label: string): string {
  const key = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    (
      {
        codex: "Codex",
        claude: "Claude Code",
        claudecode: "Claude Code",
        cursor: "Cursor",
        antigravity: "Antigravity",
        opencode: "OpenCode",
        openmodel: "Open Model",
      } as Record<string, string>
    )[key] || label
  );
}
