# Message pins

A signed-in person with room access can pin or unpin any visible message.
Authentication uses the same interactive app-session check as reactions:
owner tokens and worker credentials cannot act as a person. There is no MCP
pin tool. Local desktop rooms and unsent messages offer no pin action.

| Method | Route | Result |
|---|---|---|
| GET | `/rooms/:room/messages/pins` | `{ room_id, pins: [...] }` |
| PUT | `/rooms/:room/messages/:message_id/pin` | `{ room_id, message_id, changed }` |
| DELETE | `/rooms/:room/messages/:message_id/pin` | Same mutation result |

Each list entry contains `message_id`, `sender`, `source`, `timestamp`,
`thread_root_id`, `snippet`, `pinned_at`, and
`pinned_by: { login, name, avatar_url }`. The list contains at most 50 entries,
ordered by pin time descending, then message number descending. Message IDs
must be canonical positive `msg_<integer>` IDs within PostgreSQL integer range.

Snippets use `display_text || text`, matching the clients' displayed-text
fallback. Whitespace collapses to one space. The bound is 240 Unicode code
points, including the trailing ellipsis when truncated. Vue renders text nodes;
markup in snippets, sender names, and pin attribution cannot execute.

| Status | Code | Meaning |
|---|---|---|
| 401/403 | `person_required` | Mutation caller is not an interactive app session |
| 400 | `invalid_message_id` | Malformed/out-of-range message ID |
| 404 | `message_not_found` | Target to pin is absent or hidden |
| 409 | `pin_limit` | Room already has 50 stored pins |
| 503 | `pin_busy` | Three-second lock timeout |
| 500 | none | Opaque failure, with no database details |

Room access errors retain the existing access policy. DELETE is idempotent even
when a pin/message is absent or hidden, allowing stale pin cleanup without
disclosing message contents. Any authorized person can unpin another's pin.
Repeated PUT retains the original person and timestamp, including at the limit.

## Concurrency and visibility

Migration 0109 starts with a five-second migration lock timeout, as 0108 does.
The primary key is `(room_id, message_number)`; composite message and account
foreign keys cascade. Pin membership stores no message snapshot.

Each mutation sets transaction-local `lock_timeout = '3s'`, then acquires
`pg_advisory_xact_lock(0x50494e53, hashtext(canonicalRoomId))` using PostgreSQL's
two-integer key form. The first integer is the pins-only namespace. Hash
collisions can serialize unrelated rooms, but cannot weaken the limit. PUT
checks/locks the visible target, checks existing membership, counts, and inserts
under that lock. DELETE uses the same namespace. Committed writes alone queue
invalidation. The cap counts stored pins; hidden rows are excluded from GET
using the shared history visibility predicate. Deleting messages/accounts
removes their pins.

The room-lock audit found message creation uses `id_sequences`
(`db/utils.ts:nextRoomScopedNumber`) and inserts into `messages`
(`db/messages/create.ts`); it does not update the room row. Room renaming,
join-code rotation and focus-room lifecycle/settings do update it. A pins-only
advisory lock avoids all of those paths. A real PostgreSQL test holds the pin
lock while sending a message and separately verifies the three-second timeout.

## Client behavior

The shared `PinnedMessages.vue` component renders one horizontal marker per pin
along the left edge of the chat. Desktop mounts it in `RoomChatView.vue`; web
mounts it in `RoomTabPanels.vue`. The rail is positioned outside document flow,
so pinning, hiding, or revealing markers does not add a row or change the height
of the conversation. The message gutter reserves space for the markers.

Hovering or focusing a marker shows a bounded text preview with a short author
label and date. Common inline Markdown is reduced to plain text; Vue still
escapes all content. Clicking a marker or pressing Enter/Space reveals through
the existing message-reveal path. Arrow keys/Home/End move between markers;
Tab leaves normally, and Escape dismisses the preview even when opened by mouse.
The last selected marker is longer and brighter. The rail scrolls when needed
for the existing 50-pin limit. There is no animation, including keyboard use.

“Hide pinned messages” in desktop Room settings → General and the web room drawer
is off by default. It hides the markers in all rooms for that client and device,
persisting in local storage. It does not unpin messages, change anyone else's
view, or alter the message reveal limits. Switching it off restores the rail.
Room changes reset the selected marker and preview. Removing a focused marker
moves focus to a remaining marker, or to the room when the last pin disappears.

The same message components render markers in the timeline and threads.
Pin/Unpin appears before Add reaction in the context menu. The permalink
feature's Copy link item must be preserved when branches are integrated.
While a write is pending, further pin actions are disabled. Errors keep the
previous list and explain the refusal; background reads retry on the next
invalidation/reconnect or the rail's Retry button.

The shared store reads one complete room list; it does not seed from message
payloads. Epochs clear room/account state immediately and reject late answers.
Reads are coalesced; a read older than a mutation cannot overwrite it. Desktop
storage-mode resolution is authoritative: local reads return unavailable and
local writes never contact the API.

## Agent and stream contract

The new resource is `message_pins`. Stream invalidations carry only
`{ room_id, resource: "message_pins" }`. Pins produce no room message, receipt,
notification or push. Message-only subscribers and managed agents stay quiet.
History, single-message, thread and MCP-readable message representations are
unchanged before and after pinning; integration tests compare the actual
responses. Agents receive no new message field or tool.

## Repeatable local seed and live checks

Use your own disposable database. Set DB_URL, run `npm run db:migrate`, then
run this seed from the repository root. A reused nonempty room is refused;
choose another PINS_QA_ROOM to repeat.

```sh
PINS_QA_ROOM=message-pins-qa-v3 node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createProjectWithName, addMessage, getMessages, upsertAccount } from './src/api/db.js';
import { getMessagePins, setMessagePin } from './src/api/db/messages/pins.js';
import { pool } from './src/api/db/client.js';
try {
  const room = await createProjectWithName(process.env.PINS_QA_ROOM);
  assert.equal((await getMessages(room.id)).messages.length, 0);
  const account = await upsertAccount({ provider: 'github', provider_user_id: 'pins-qa-person', login: 'pins-qa-person', display_name: 'Pin QA' });
  for (let i = 1; i <= 350; i++) {
    await addMessage(room.id, 'Pin QA', i === 1 ? 'Older pinned message' : 'History ' + i, { source: 'browser' });
  }
  const root = await addMessage(room.id, 'Ada', 'Pinned thread root', { source: 'browser' });
  const reply = await addMessage(room.id, 'Grace', 'Stored reply', { source: 'system', thread_root_message_id: root.id, display_text: '<script>literal text</script> ' + '😀'.repeat(250) });
  for (const number of [1, 350, 351, 352]) {
    assert.equal(await setMessagePin({ roomId: room.id, messageNumber: number, accountId: account.id, pinned: true }), 'changed');
  }
  const pins = await getMessagePins(room.id);
  assert.equal(pins.length, 4);
  assert.equal(Array.from(pins[0].snippet).length, 240);
  assert.equal(pins[0].thread_root_id, root.id);
  console.log(JSON.stringify({ room: room.id, root: root.id, reply: reply.id, pins: pins.map(p => p.message_id) }, null, 2));
} finally { await pool.end(); }
JS
```

Start your own API on port 3001 and the existing web dev server
(`npm run dev:api`, `npm --prefix src/web run dev`). Open
`/in/message-pins-qa-v3` on that web origin. Do not replace another session's API
or start a second Electron instance.

Live checks for the reviewer; shell, SSR and handler tests do not perform them:

1. On desktop and web, pin/unpin from context menus. Check menu order, bottom-edge
   clipping, signed-out/local/unsent action hiding, and markers in timeline/thread.
2. Use the edge markers with pointer and keyboard. Verify escaped previews,
   attribution, newest-first order, bounded scrolling, arrow/Enter behavior,
   Escape dismissal, normal Tab navigation, and no timeline shift.
3. Reveal recent, older and thread-reply entries; verify highlight and the shared
   history/thread path. A target beyond the existing bound shows its usual notice.
4. With two clients, add/remove pins and reconnect one. Changes arrive without
   a chat message, receipt, push or agent wake. Switch accounts/rooms during a
   delayed request and verify old pins do not appear.
5. Remove all pins: no markers remain. Exercise 0→1→0 while at the bottom and
   while scrolled up. Hide/show the markers in Settings, reload, and verify the
   saved preference and unchanged pin membership and reading position.
6. Fill 50 pins, attempt a 51st, and check the clear refusal. Repeating a pin
   retains its attribution. Remove a pin and retry. Simulate an offline write
   and verify the prior membership remains. Desktop errors must contain no IPC
   wrapper; the 50-pin notice must match the documented text.
7. Switch through board, activity and other tabs: their layout must be unchanged
   by the chat-only markers. Check the opaque preview, hover, active and
   keyboard focus states in light and dark themes.

Server suites are explicitly registered in CI. Automated proof also includes
the shared store, desktop IPC/stream, both providers and shared UI handlers.
