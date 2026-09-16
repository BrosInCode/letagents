export interface DirectoryRoom {
  id: string
  title: string
  kind: 'topic' | 'task' | 'branch'
  kindLabel?: string
  closed: boolean
  description: string
  createdAt: string | null
  closedAt: string | null
  searchText?: string
}

export interface DirectoryTask {
  id: string
  title: string
  description: string
  status: string
  roomId?: string
  roomClosed?: boolean
}

export function roomDisplayTitle(title: string): string {
  return title.replace(/^Focus:\s*/i, '').trim() || 'Untitled room'
}

export function filterRooms(
  rooms: readonly DirectoryRoom[],
  closed: boolean,
  query: string,
): DirectoryRoom[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return rooms
    .filter(
      (room) =>
        room.closed === closed &&
        terms.every((term) =>
          `${room.title} ${room.kind} ${room.kindLabel || ''} ${room.description} ${room.searchText || ''}`
            .toLocaleLowerCase()
            .includes(term),
        ),
    )
    .sort((a, b) => {
      const date = (room: DirectoryRoom) =>
        Date.parse((closed ? room.closedAt : null) || room.createdAt || '') || 0
      return (
        date(b) - date(a) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id)
      )
    })
}

export function roomDate(value: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return ''
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

export function roomKindLabel(room: DirectoryRoom): string {
  return (
    room.kindLabel ||
    (room.kind === 'branch'
      ? 'Git branch'
      : room.kind === 'task'
        ? 'Task'
        : 'Topic')
  )
}

export function taskStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    open: 'Open',
    accepted: 'Ready to start',
    assigned: 'Assigned',
    in_progress: 'In progress',
    in_review: 'Ready for review',
    blocked: 'Blocked',
    proposed: 'Proposed',
  }
  return labels[status] || status.replace(/_/g, ' ')
}
