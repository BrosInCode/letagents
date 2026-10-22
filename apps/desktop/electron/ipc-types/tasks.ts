export interface DesktopTaskSummary {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  assigneeAgentKey: string | null;
  createdBy: string | null;
  prUrl: string | null;
  workflowArtifacts: Array<{
    provider: string;
    kind: string;
    id: string | null;
    number: number | null;
    title: string | null;
    url: string | null;
    ref: string | null;
    state: string | null;
  }>;
  workflowRefs: Array<{
    provider: string;
    kind: string;
    label: string;
    url: string;
  }>;
  /**
   * Ticket connectors PR6: pull requests Jev suggested for this card that no
   * person accepted yet. The card's details offer Accept and Reject for each.
   */
  jevSuggestedPullRequests?: Array<{ url: string; number: number | null; title: string | null }>;
  activeLeases: Array<{
    id: string;
    kind: "work" | "review" | string;
    holderLabel: string | null;
    agentKey: string | null;
    agentSessionId: string | null;
    status: string;
    updatedAt: string | null;
  }>;
  activeLocks: Array<{
    id: string;
    scope: "room" | "task" | string;
    reason: string | null;
    message: string | null;
    createdBy: string | null;
  }>;
  stalePromptState: {
    isStale: boolean;
    reason: string | null;
    staleForMs: number | null;
    muted: boolean;
    mutedBy: string | null;
    mutedAt: string | null;
  } | null;
  /** The ticket the card names, e.g. `jira:HT-1234`. Absent on local rooms. */
  externalRef?: string | null;
  /** The tracker's state for that ticket. Owned by the tracker. */
  ticketState?: string | null;
  createdAt: string | null;
  updatedAt: string;
}

/** The tracker record behind a card (ticket connectors). */
export interface DesktopTaskTicket {
  externalRef: string;
  provider: import("../../../../shared/ticket-connectors.mjs").TrackerProvider;
  key: string;
  title: string;
  ticketState: string;
  rawStatus: string;
  assigneeLabel: string | null;
  url: string | null;
  trackerUpdatedAt: string | null;
  syncedAt: string;
}

/** A My work read: one page, optionally narrowed by tracker, room, or "needs me". */
export interface DesktopMyWorkQuery {
  cursor?: string | null;
  limit?: number;
  /** `native` lists cards that name no ticket. */
  tracker?: import("../../../../shared/ticket-connectors.mjs").TrackerProvider | "native" | null;
  /** The server's room id. */
  roomId?: string | null;
  needsMe?: boolean;
  /** Include finished work alongside active work; omitted by legacy callers. */
  includeCompleted?: boolean;
}

/** A room ticket filter to save or test. */
export interface DesktopTrackerFilterInput {
  connectionId: string;
  filter: string;
  enabled?: boolean;
}

/** A room message that names a card's ticket key. */
export interface DesktopTaskMention {
  messageId: string;
  threadRootId: string;
  key: string;
  sender: string;
  text: string;
  timestamp: string;
}

export interface DesktopTaskMutationResult {
  task: DesktopTaskSummary;
}

export interface DesktopTaskCreateInput {
  title: string;
  description?: string | null;
}

export interface DesktopTaskLeaseActionInput {
  action: "release" | "handoff";
  lease_id?: string | null;
  target_actor_key?: string | null;
  target_actor_instance_id?: string | null;
  target_agent_session_id?: string | null;
  reason?: string | null;
}

export interface DesktopTaskReviewLeaseActionInput {
  action: "assign" | "claim" | "release";
  lease_id?: string | null;
  target_actor_key?: string | null;
  target_actor_instance_id?: string | null;
  target_agent_session_id?: string | null;
  reason?: string | null;
}

export interface DesktopTaskWorkerActionInput {
  action: "claim" | "start" | "block" | "resume" | "submit_review";
  reason?: string | null;
}

export interface DesktopTaskReviewWorkerActionInput {
  action: "claim" | "release";
  lease_id?: string | null;
  reason?: string | null;
}
