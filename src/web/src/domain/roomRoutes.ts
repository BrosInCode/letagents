export function encodeRoomPathIdentifier(identifier: string): string {
  return String(identifier)
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

export function buildDirectRoomPath(identifier: string | null | undefined): string {
  const value = identifier?.trim()
  return value ? `/in/${encodeRoomPathIdentifier(value)}` : ''
}

export function buildFocusRoomPath(input: {
  parentRoomId?: string | null
  focusKey?: string | null
  sourceTaskId?: string | null
}): string {
  const parentRoomId = input.parentRoomId?.trim()
  const focusKey = input.focusKey?.trim() || input.sourceTaskId?.trim()
  return parentRoomId && focusKey
    ? `/in/${encodeRoomPathIdentifier(parentRoomId)}/focus/${encodeURIComponent(focusKey)}`
    : ''
}

export function buildRoomSharePath(input: {
  identifier?: string | null
  projectId?: string | null
  kind?: string | null
  parentRoomId?: string | null
  focusKey?: string | null
  sourceTaskId?: string | null
}): string {
  if (input.kind === 'focus') {
    const focusPath = buildFocusRoomPath(input)
    if (focusPath) return focusPath
  }

  return buildDirectRoomPath(input.identifier?.trim() || input.projectId?.trim())
}

export function buildRoomShareUrl(
  input: Parameters<typeof buildRoomSharePath>[0],
  origin: string,
): string {
  const path = buildRoomSharePath(input)
  return path ? `${origin.replace(/\/+$/, '')}${path}` : ''
}
