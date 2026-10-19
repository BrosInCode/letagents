# Inbox: GitHub events across rooms

## One row per event

A focus room reads its repo room's GitHub event lane, unless it is a generated git-ref focus room or its `github_event_routing` is `focus_owned_only` (see `getGitHubEventLaneRoomId` in `src/api/routes/rooms/events.ts`). The desktop Inbox reads updates for every room, so the repo room and each of its focus rooms return the same events, with the same event ids. Without care, one failed check becomes one Updates row per room.

The Inbox builder (`buildUniversalInbox`) gives each GitHub event to one room before it builds the rows (`claimGitHubEvents` in `apps/desktop/renderer/src/components/desktop/content/room-inbox/github-event-claims.ts`):

1. The repo room keeps the event when it carries it. The desktop knows the repo room of a focus room from the account room list: `getDesktopNeedsYou` sets `parentRoomIdentifier` on each focus room to the room it is listed under.
2. Otherwise the first room that carries the event, by room identifier, keeps it.

The rule uses event ids only, not room settings. A focus room that owns its lane has its own event ids, so it keeps its own rows. Repeated failures of one check in the kept room still group into one row with an occurrence count. The row names, and "Open room" opens, the room that kept the event.

## The Updates count

Room updates (replies, checks, agent activity) are read only while the Inbox is open. A read made elsewhere returns `updatesIncluded: false`, and its Updates list holds task rows only. Until a read with updates completes, the Inbox shows no number on the Updates tab or the Updates heading, and "Mark all updates read" is not available. The Needs you count and the sidebar badge do not depend on updates.
