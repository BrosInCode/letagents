# Personal room unread bookmarks

On a top-level timeline message, **Mark unread from here** saves a personal
bookmark. Desktop also offers **Mark as unread** in a room's sidebar menu when
its latest message is known and it is not already unread. The desktop sidebar
and web Rooms directory show the room as unread while its bookmark exists.

A bookmark never clears during the visit in which it was set; on a later visit
(selecting the room again or reloading the app/tab), it clears when the timeline
is at the bottom while the window is visible and focused. Refresh, message
arrival and automatic scrolling do not clear it. Switching Chat tabs within the
same room is still the same visit. A newer mark supersedes an older clear.
The existing desktop **Mark as read** action (including batch selection) explicitly
clears that room's bookmark too, even during the visit in which it was set.

Opening the room uses the existing bounded permalink reveal (at most its
existing 20-page budget). A static **New messages** separator appears above the
target and stays for the rest of the visit after the bookmark clears. It resets
when the room visit changes. If loading fails or the target is unavailable, the
bookmark remains, the timeline falls back to its normal bottom view, and no
separator appears.
Thread replies have no mark-unread action or separate bookmark.

## Storage and isolation

Main-room read state is local today. Desktop's existing, unscoped
`letagents-desktop:read-room-message-ids` map is unchanged. Explicit bookmarks
use a separate account-scoped localStorage key, under
`letagents-desktop:room-unread` or `letagents-web:room-unread`. Each room stores
one target message ID, revision and timestamp. Each account retains at most
500 rooms, dropping the least recently marked room first.

Same-origin windows sharing storage refresh from storage events. Other devices,
browser profiles, and desktop versus web do not synchronize. A storage failure
does not create an in-memory bookmark that would disappear on reload.

Marking writes no network request, desktop IPC, room event or message. It does
not change human visibility evidence, thread read positions, private-message
read positions, Inbox dismissals, Needs you, push suppression, notification
settings or agent delivery. Previously published read receipts remain intact.
The existing reveal may read history on a later visit.

## Verification

Store and Vue lifecycle tests cover persistence, account/room isolation, the
500-room cap, blocked storage, revisions without secure-context crypto, storage
events, stale clears, explicit sidebar clearing, visit-latched dividers,
current-visit and Chat-tab retention, visibility/focus, automatic scrolling and unreachable
targets. Real message setup handlers test top-level eligibility and verify
that marking leaves message data unchanged and emits no room action.

Live QA remains separate: desktop and web menu keyboard/focus behavior;
older-target reveal and separator placement; sidebar/directory dots; same-profile
windows and account switching; reload/reopen at top and bottom; failed-history
fallback; light/dark and narrow layouts. No browser or desktop live check is
claimed by the unit tests.
