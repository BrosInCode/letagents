import { inject, provide, type InjectionKey } from 'vue'
import { apiFetch, roomPath } from '../../composables/room/api'
import type { RoomGitHubEvent, RoomMessage, RoomTask } from '../../composables/room/types'
import type { PersonTarget } from '../../../../../apps/desktop/renderer/src/domain/person-target'
import type { PersonWorkEvent, PersonWorkTask } from '../../../../../apps/desktop/renderer/src/domain/person-work'
import type { PersonWorkServices } from '../../../../../apps/desktop/renderer/src/domain/person-work-services'
import { safeWorkUrl } from '../../../../../shared/ui/my-work/model'

type OpenWork = (target: PersonTarget, event: MouseEvent) => void
type PersonWorkContext = { open: OpenWork; available: () => boolean }
const workKey: InjectionKey<PersonWorkContext> = Symbol('person-work')
export function providePersonWork(open: OpenWork, available: () => boolean): void { provide(workKey, { open, available }) }
export function injectPersonWork(): PersonWorkContext | null { return inject(workKey, null) }

/** Only server-authenticated human profiles identify whose work can be opened. */
export function personWorkTarget(message: Pick<RoomMessage, 'source' | 'sender' | 'sender_profile'>): PersonTarget | null {
  const profile = message.sender_profile
  if (message.source !== 'browser' || !profile?.login?.trim()) return null
  return { login: profile.login, displayName: message.sender || profile.login, avatarUrl: profile.avatar_url }
}

export function personWorkTask(task: RoomTask): PersonWorkTask {
  return {
    id: task.id, title: task.title, prUrl: task.pr_url,
    externalRef: task.external_ref, ticketState: task.ticket_state,
    workflowArtifacts: task.workflow_artifacts.map(artifact => ({
      ...artifact, id: artifact.id ?? null, number: artifact.number ?? null,
      title: artifact.title ?? null, url: artifact.url ?? null,
      ref: artifact.ref ?? null, state: artifact.state ?? null,
    })),
  }
}

function personWorkEvent(event: RoomGitHubEvent): PersonWorkEvent {
  return {
    id: event.id, eventType: event.event_type, action: event.action,
    githubObjectId: event.github_object_id, githubObjectUrl: event.github_object_url,
    title: event.title, state: event.state, actorLogin: event.actor_login,
    metadata: event.metadata || {}, linkedTaskId: event.linked_task_id,
    providerEventAt: event.provider_event_at, providerObjectUpdatedAt: event.provider_object_updated_at,
    eventOrderAt: event.event_order_at, headSha: event.head_sha, createdAt: event.created_at,
  }
}

/** The web uses the same authenticated room endpoints and rendering as desktop. */
export function createPersonWorkServices(
  request: typeof apiFetch = apiFetch,
  openUrl = (url: string) => { window.open(url, '_blank', 'noopener,noreferrer') },
): PersonWorkServices {
  return {
    async getEvents(roomId, options) {
      const params = new URLSearchParams({ limit: String(options.limit), event_type: options.eventType, since: options.since })
      if (options.after) params.set('after', options.after)
      const page = await request(`${roomPath(roomId)}/events?${params}`)
      return {
        events: (page.events || []).map(personWorkEvent), hasMore: page.has_more === true,
        roomIdentifier: page.room_id || roomId, githubRoomIdentifier: page.github_room_id || null,
      }
    },
    async getTicket(roomId, taskId) {
      const { ticket } = await request(`${roomPath(roomId)}/tasks/${encodeURIComponent(taskId)}/ticket`)
      return ticket ? { externalRef: ticket.external_ref, url: safeWorkUrl(ticket.url) || null } : null
    },
    async openExternalUrl(url) {
      const safe = safeWorkUrl(url)
      if (!safe) throw new Error('This link could not be opened.')
      openUrl(safe)
    },
  }
}
