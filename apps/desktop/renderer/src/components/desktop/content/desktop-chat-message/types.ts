export interface SenderIdentity {
  displayName: string;
  ownerAttribution: string | null;
  ideLabel: string | null;
}

export interface AgentModalTarget {
  actorLabel: string | null;
  displayName: string;
  ownerAttribution: string | null;
  ideLabel: string | null;
  sender: string;
}

export interface GitHubEventPresentation {
  kind: "pull-request" | "issue" | "review" | "comment" | "check" | "repository" | "generic";
  tone: "violet" | "amber" | "emerald" | "rose" | "sky" | "slate";
  kindLabel: string;
  statusLabel: string | null;
  headline: string;
  detail: string | null;
  repository: string | null;
  taskId: string | null;
  url: string | null;
  urlLabel: string;
}
