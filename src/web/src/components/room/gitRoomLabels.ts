import type { GitRoomInfo } from '@/composables/useRoom'

export function gitRoomProviderLabel(gitRoom: GitRoomInfo): string {
  return gitRoom.provider === 'github' ? 'GitHub' : gitRoom.host
}

export function gitRoomRefLabel(gitRoom: GitRoomInfo): string {
  const ref = gitRoom.ref
  if (
    ref.name &&
    ref.head_repository?.full_name &&
    ref.head_repository.full_name !== gitRoom.repository.full_name
  ) {
    return `${ref.head_repository.owner}:${ref.name}`
  }
  return ref.name || ref.default_branch || ref.type.replace('_', ' ')
}

export function gitRoomRefTypeLabel(gitRoom: GitRoomInfo): string {
  switch (gitRoom.ref.type) {
    case 'default_branch':
      return 'Default branch'
    case 'branch':
      return 'Branch'
    case 'tag':
      return 'Tag'
    case 'pull_request':
      return 'Pull request'
  }
}

export function gitRoomRefTitle(gitRoom: GitRoomInfo): string {
  const type = gitRoomRefTypeLabel(gitRoom)
  const ref = gitRoom.ref
  if (ref.name && ref.head_repository?.full_name) {
    return `${type}: ${ref.head_repository.full_name}:${ref.name}`
  }
  return ref.name ? `${type}: ${ref.name}` : type
}

export function gitRoomAccessLabel(gitRoom: GitRoomInfo): string {
  switch (gitRoom.access_mode) {
    case 'private':
      return 'Private'
    case 'public':
      return 'Public'
    default:
      return 'Unknown'
  }
}

export function gitRoomAccessTitle(gitRoom: GitRoomInfo): string {
  return `${gitRoomAccessLabel(gitRoom)} repository access`
}
