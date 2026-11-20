// The GitHub chat-message parser is shared with the desktop app.
export {
  isGitHubRoomMessage,
  isLowSignalGitHubCheckMessage,
  parseGitHubEventPresentation,
  type GitHubEventKind,
  type GitHubEventPresentation,
  type GitHubEventTone,
  type GitHubMessageLike,
} from '../../../../../shared/ui/github-event-message'
