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
  agentKey: string | null;
  agentSessionId: string | null;
}

export type AgentInspectorRequest =
  | {
      kind: "supervised";
      supervisorEntryId: string;
      target: AgentModalTarget;
    }
  | {
      kind: "participant";
      target: AgentModalTarget;
    };

/**
 * The detail surface never infers supervision for itself. Chat and Activity
 * resolve a participant into one of these explicit selections before opening
 * the Inspector, so a load failure cannot silently turn a supervised agent
 * into an external participant.
 */
export type AgentInspectorSelection =
  | (AgentModalTarget & {
      kind: "supervised";
      supervisorEntryId: string;
    })
  | (AgentModalTarget & {
      kind: "external";
      supervisorEntryId?: never;
    })
  | (AgentModalTarget & {
      kind: "resolving";
      supervisorEntryId?: never;
    })
  | (AgentModalTarget & {
      kind: "unavailable";
      supervisorEntryId?: never;
      unavailableReason: "missing" | "ambiguous" | "load_error";
      unavailableDetail?: string;
    });

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
