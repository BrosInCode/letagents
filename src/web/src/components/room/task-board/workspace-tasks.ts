import type { BoardTask } from '../../../../../../shared/ui/board/types'
import type { RoomAgentPresence, RoomTask, TaskGitHubArtifactStatus } from '../../../composables/useRoom'
import { formatActorName, getTaskActions } from './model'

export function webBoardTask(task: RoomTask, presence: readonly RoomAgentPresence[], github?: TaskGitHubArtifactStatus | null): BoardTask {
  const agent = task.assignee_agent_key ? presence.find(person => person.agent_key === task.assignee_agent_key) : null
  const url = task.pr_url || github?.pr_url || task.workflow_artifacts?.find(artifact => artifact.kind === 'pull_request' && artifact.url)?.url || task.workflow_refs?.find(ref => ref.kind === 'pull_request')?.url
  const pr = task.workflow_artifacts?.find(artifact => artifact.kind === 'pull_request' && artifact.url === url)
  const matchingGithub = github?.pr_url === url ? github : null
  const number = Number(matchingGithub?.pr_number || pr?.number || /\/pull\/(\d+)(?:[/?#]|$)/.exec(url || '')?.[1] || 0)
  const separator = task.external_ref?.indexOf(':') ?? -1
  return {
    id: task.id, title: task.title, description: task.description, status: task.status,
    assigneeLabel: formatActorName(task.assignee) || null,
    assigneeKey: task.assignee_agent_key || (task.assignee ? `label:${task.assignee}` : null),
    provider: agent?.runtime && agent.runtime !== 'unknown' ? agent.runtime : agent?.ide_label || null,
    pr: url ? { url, number: number || null, state: matchingGithub?.pr_merged ? 'merged' : matchingGithub?.pr_state || pr?.state } : null,
    ticket: separator > 0 && task.external_ref
      ? { provider: task.external_ref.slice(0, separator), key: task.external_ref.slice(separator + 1) } : null,
    updatedAt: task.updated_at,
    allowedTransitions: getTaskActions(task).map(action => ({ id: action.status, label: action.label, targetStatus: action.status })),
  }
}
