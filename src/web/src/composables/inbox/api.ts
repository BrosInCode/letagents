import type { KnowledgeRecord } from '../../../../../shared/room-knowledge.mjs'
import { eventTime, groupActivity, githubUrl } from '../../../../../shared/ui/activity/model'
import type { RoomAgentPresence, RoomGitHubEvent, RoomMessage, RoomReasoningSession, RoomTask } from '../room/types'
import { roomPath } from '../room/api'

export type InboxSection = 'needs-you' | 'updates' | 'answered'
export interface InboxRoom { id: string; label: string; parentId?: string }
export interface InboxItem {
  key: string; roomId: string; roomName: string; section: InboxSection; category: string;
  title: string; body: string; actor: string; timestamp: string; fingerprint: string;
  agent?: boolean; agentKey?: string | null; provider?: string | null; avatarUrl?: string | null;
  record?: KnowledgeRecord; taskId?: string; messageId?: string; url?: string | null;
  history?: Array<{ id: string; label: string; body: string; timestamp: string }>;
}
interface Thread { root: RoomMessage; summary: { latest_reply: RoomMessage | null; unread_count: number; has_unread: boolean } }
export interface ThreadPage { threads: Thread[]; has_more: boolean }
interface AccountRoom { room_id: string; display_name: string; focus_rooms?: AccountRoom[] }
interface AttentionPage { records: KnowledgeRecord[]; tasks?: RoomTask[]; truncated?: boolean }
export interface InboxSnapshot { rooms: InboxRoom[]; items: InboxItem[]; failures: Array<{ roomId: string; label: string }>; limited: boolean; threads: Record<string, ThreadPage> }
export type InboxFetch = (path: string, init?: RequestInit) => Promise<any>
const timestamp = (value: string) => Date.parse(value) || 0
export const compareItems = (a: InboxItem, b: InboxItem) => timestamp(b.timestamp) - timestamp(a.timestamp) || a.key.localeCompare(b.key)
const messageText = (message: RoomMessage) => message.display_text || message.text || ''
function identity(key: string | null | undefined, presence: RoomAgentPresence[]) {
  const person = key ? presence.find(person => person.agent_key === key || person.agent_session_id === key) : undefined
  return { agent: true, agentKey: key, provider: person?.ide_label || person?.runtime }
}
function base(room: InboxRoom, kind: string, id: string) {
  return { key: JSON.stringify([room.id, kind, id]), roomId: room.id, roomName: room.label }
}
export function threadItems(room: InboxRoom, page: ThreadPage): InboxItem[] {
  return page.threads.filter(thread => thread.summary.has_unread || thread.summary.unread_count > 0).map(({ root, summary }) => {
    const latest = summary.latest_reply || root
    return { ...base(room, 'thread', root.id), section: 'updates', category: 'Unread replies', title: messageText(root) || 'Thread',
      body: messageText(latest), actor: latest.sender, timestamp: latest.timestamp, fingerprint: `${latest.id}:${summary.unread_count}`,
      agent: latest.source === 'agent', agentKey: latest.agent_identity?.agent_key, provider: latest.agent_identity?.ide_label,
      avatarUrl: latest.sender_profile?.avatar_url, messageId: root.id,
      history: [{ id: root.id, label: `Thread started by ${root.sender}`, body: messageText(root), timestamp: root.timestamp },
        ...(latest.id === root.id ? [] : [{ id: latest.id, label: `Latest reply from ${latest.sender}`, body: messageText(latest), timestamp: latest.timestamp }])] }
  })
}
export function safeExternalUrl(value: string | null | undefined): string | undefined {
  try { const url = new URL(value || ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
/** Existing room endpoints only; the browser never exposes local host permissions. */
export function createInboxApi(fetcher: InboxFetch) {
  return {
    async load(signal?: AbortSignal): Promise<InboxSnapshot> {
      const account = await fetcher('/account/rooms?limit=100', { signal }) as { rooms: AccountRoom[] }
      const rooms = [...new Map(account.rooms.flatMap(room => [{ id: room.room_id, label: room.display_name },
        ...(room.focus_rooms || []).map(focus => ({ id: focus.room_id, label: focus.display_name, parentId: room.room_id }))]).map(room => [room.id, room])).values()]
      const result: InboxSnapshot = { rooms, items: [], failures: [], limited: account.rooms.length >= 100, threads: {} }
      const queue = [...rooms]
      const eventPages: Array<{ room: InboxRoom; events: RoomGitHubEvent[] }> = []
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let room = queue.shift(); room && !signal?.aborted; room = queue.shift()) {
          const path = roomPath(room.id)
          const sources = await Promise.allSettled([
            fetcher(`${path}/attention`, { signal }), fetcher(`${path}/messages/threads?filter=unread&limit=75`, { signal }),
            fetcher(`${path}/presence`, { signal }), fetcher(`${path}/events?limit=100`, { signal }),
            fetcher(`${path}/reasoning-sessions`, { signal }),
            fetcher(`${path}/tasks?status=done&limit=200&order=recent`, { signal }), fetcher(`${path}/tasks?status=merged&limit=200&order=recent`, { signal }),
          ])
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
          const [requests, threads, agents, events, sessions, done, merged] = sources.map((source, index) => {
            if (source.status === 'fulfilled') return source.value
            result.failures.push({ roomId: room!.id, label: `${room!.label}: ${['Requests', 'Replies', 'Agents', 'GitHub checks', 'Agent sessions', 'Completed work', 'Merged work'][index]}` })
            return null
          }) as [AttentionPage | null, ThreadPage | null, { presence: RoomAgentPresence[] } | null, { events: RoomGitHubEvent[]; has_more?: boolean } | null, { sessions?: RoomReasoningSession[]; reasoning_sessions?: RoomReasoningSession[] } | null, { tasks: RoomTask[]; has_more?: boolean } | null, { tasks: RoomTask[]; has_more?: boolean } | null]
          const presence = agents?.presence || []
          result.limited ||= Boolean(requests?.truncated || events?.has_more || done?.has_more || merged?.has_more)
          for (const record of requests?.records || []) result.items.push({ ...base(room, 'request', record.id), section: record.response ? 'answered' : 'needs-you',
            category: record.response?.closed ? 'Closed' : record.category.charAt(0).toUpperCase() + record.category.slice(1), title: record.title, body: record.body,
            actor: record.author.label, timestamp: record.response?.at || record.created_at, fingerprint: String(record.version), record,
            ...(record.author.kind === 'agent' ? identity(record.author.id, presence) : {}) })
          for (const task of [...requests?.tasks || [], ...done?.tasks || [], ...merged?.tasks || []]) result.items.push({ ...base(room, 'task', task.id), section: 'updates',
            category: ({ blocked: 'Blocked task', in_review: 'Task review', done: 'Completed', merged: 'Merged' } as Record<string, string>)[task.status] || task.status,
            title: task.title, body: task.description || '', actor: task.assignee || 'Task board', timestamp: task.updated_at, fingerprint: `${task.status}:${task.updated_at}`, taskId: task.id,
            ...(task.assignee_agent_key ? identity(task.assignee_agent_key, presence) : {}) })
          if (threads) { result.threads[room.id] = threads; result.items.push(...threadItems(room, threads)) }
          if (events) eventPages.push({ room, events: events.events })
          for (const session of sessions?.sessions || sessions?.reasoning_sessions || []) {
            if (session.status !== 'blocked' && !session.blocker && !session.latest_payload?.blocker) continue
            result.items.push({ ...base(room, 'session', session.id), section: 'updates', category: 'Blocked agent',
              title: session.title || session.actor_label || 'Blocked agent', body: session.blocker || session.latest_payload?.blocker || session.summary || '',
              actor: session.actor_label || 'Agent', timestamp: session.updated_at || session.created_at || '', fingerprint: `${session.updated_at}:${session.blocker || ''}`,
              ...identity(session.agent_key, presence), taskId: session.task_id || undefined, messageId: session.anchor_message_id || undefined,
              history: (session.updates || []).map(update => ({ id: update.id, label: update.status || 'Update', body: update.summary, timestamp: update.created_at })) })
          }
          for (const person of presence.filter(person => person.session_kind === 'worker' && person.activity_state === 'offline')) result.items.push({ ...base(room, 'offline', person.agent_key || person.actor_label),
            section: 'updates', category: 'Agent offline', title: person.display_name || person.actor_label, body: person.status_text || 'This agent is offline. Open its room to see the latest activity.',
            actor: person.display_name || person.actor_label, timestamp: person.last_heartbeat_at, fingerprint: person.last_heartbeat_at, ...identity(person.agent_key, presence) })
        }
      }))
      // A focus room may receive the same GitHub lane as its parent. Prefer the parent without duplicating events.
      const seen = new Set<string>()
      for (const { room, events } of eventPages.sort((a, b) => Number(Boolean(a.room.parentId)) - Number(Boolean(b.room.parentId)) || a.room.id.localeCompare(b.room.id))) {
        const unique = events.filter(event => { if (seen.has(event.id)) return false; seen.add(event.id); return true })
        for (const group of groupActivity(unique).filter(group => group.attention)) result.items.push({ ...base(room, 'github', group.id), section: 'updates', category: 'GitHub attention',
          title: group.title, body: group.summary || `${group.status} · ${group.title}`, actor: group.actor || 'GitHub', timestamp: group.time,
          fingerprint: group.events.map(event => event.id).sort().join(':'), url: githubUrl(group.url), taskId: group.taskIds[0],
          history: group.events.map(event => ({ id: event.id, label: event.title || event.event_type.replace(/_/g, ' '), body: event.state || event.action, timestamp: eventTime(event) })) })
      }
      result.items = [...new Map(result.items.map(item => [item.key, item])).values()].sort(compareItems)
      return result
    },
    threads(roomId: string, before: string, signal?: AbortSignal): Promise<ThreadPage> {
      return fetcher(`${roomPath(roomId)}/messages/threads?${new URLSearchParams({ filter: 'unread', limit: '75', before })}`, { signal })
    },
    async answer(item: InboxItem, response: string, close = false): Promise<KnowledgeRecord> {
      if (!item.record || (!close && !response.trim())) throw new Error('Write a response before sending.')
      const result = await fetcher(`${roomPath(item.roomId)}/attention/${encodeURIComponent(item.record.id)}/${close ? 'close' : 'respond'}`, {
        method: 'POST', body: JSON.stringify({ expected_version: item.record.version, ...(close ? {} : { response }) }),
      })
      return result.record
    },
  }
}
