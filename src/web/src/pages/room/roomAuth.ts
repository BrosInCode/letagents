export type RoomAccessState = 'checking' | 'signed_out' | 'authorized'

export function resolveRoomAccessState(input: {
  hasCheckedSession: boolean
  isCheckingSession: boolean
  isSignedIn: boolean
}): RoomAccessState {
  if (!input.hasCheckedSession || input.isCheckingSession) return 'checking'
  return input.isSignedIn ? 'authorized' : 'signed_out'
}
