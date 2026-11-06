import type { DesktopAgentPresence, DesktopTaskSummary } from "../../../../../../electron/ipc-types";
import type { BoardTask } from "../../../../../../../../shared/ui/board/types";
import { compactPerson } from "./formatters";
import { ticketRefParts } from "./ticket-ref";
import type { TaskAction } from "./types";

/** Keep execution authority in the existing controller; the shared board only sees its permitted moves. */
export function desktopBoardTask(task: DesktopTaskSummary, presence: readonly DesktopAgentPresence[], actions: readonly TaskAction[]): BoardTask {
  const agent = task.assigneeAgentKey ? presence.find(person => person.agentKey === task.assigneeAgentKey) : null;
  const prUrl = task.prUrl || task.workflowArtifacts.find(artifact => artifact.kind === "pull_request" && artifact.url)?.url || task.workflowRefs.find(ref => ref.kind === "pull_request")?.url;
  const pr = task.workflowArtifacts.find(artifact => artifact.kind === "pull_request" && artifact.url === prUrl);
  const number = pr?.number ?? Number(/\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl || "")?.[1] || 0);
  const ticket = ticketRefParts(task.externalRef);
  return {
    id: task.id, title: task.title, description: task.description, status: task.status,
    assigneeLabel: compactPerson(task.assignee) || null,
    assigneeKey: task.assigneeAgentKey || (task.assignee ? `label:${task.assignee}` : null),
    provider: agent?.runtime && agent.runtime !== "unknown" ? agent.runtime : agent?.ideLabel || null,
    pr: prUrl ? { url: prUrl, number: number || null, state: pr?.state } : null,
    ticket: ticket ? { key: ticket.key, provider: ticket.provider } : null,
    updatedAt: task.updatedAt,
    allowedTransitions: actions.flatMap(action => action.targetStatus
      ? [{ id: action.id, label: action.label, targetStatus: action.targetStatus }] : []),
  };
}
