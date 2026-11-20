// The GitHub chat-message parser is shared with the web app.
export {
  isGitHubRoomMessage,
  isLowSignalGitHubCheckMessage,
  parseGitHubEventPresentation as parseGitHubEvent,
} from "../../../../../../../../shared/ui/github-event-message";
