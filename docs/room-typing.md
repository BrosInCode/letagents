# Typing indicators

Signed-in people composing in the main room composer see other people's names on
desktop and web: one name, two names, or “Several people are typing…”. Thread
composers, anonymous readers, agents, local-only rooms and rental rooms do not
participate. Other devices belonging to the same account never show self typing.

## Transport and authority

`POST /rooms/:room/typing` uses the same interactive app-session check as reactions
and the existing canonical-room participant/access resolver. The exact body is
`{ client_id, sequence, typing, ttl_ms }`; it carries no draft text, length,
attachment, message or thread identifier. The server derives the account/name.
Valid, accepted or silently throttled reports return 204. Malformed bodies return
400; anonymous and non-person credentials are rejected. Rental focus rooms are
silent no-ops, and local desktop rooms make no request.

Opted-in person SSE connections request `stream_capability=room_typing_v1`.
The named event contains that report plus canonical `room_id`, server-derived
`account_id`/`name` and `expires_at`. It has no event ID/cursor. Legacy clients
without the capability receive no hint. The server excludes self by account
before serialization, including other devices, and rejects agent subscriptions
even if they request the capability. Subscription cleanup and authorization use
the same existing stream lifecycle as messages; this change adds no authorization
mechanism.

The service uses one room-indexed bridged emitter outside RoomEventBroker.
A separate PostgreSQL NOTIFY channel carries small inline hints across API
processes. Older API processes do not listen on this channel. Neither publishing
nor receiving enters the ordered durable bridge queues or produces loss markers.
One bridge publish can be in flight per process; excess hints drop. Failed or
expired notifications are discarded, without retry or replay.

On SSE, hints use a separate synchronous best-effort write. Existing buffered
bytes, drain pressure or an authorization check already in flight cause a drop.
Denied or failed typing authorization checks also drop only the hint; the next
real event enforces the stream's existing authorization and closure behavior.
Hints never wait in the message write queue or alter message ordering. Web/native
handlers bypass bootstrap/gap buffers. Desktop forwards hints only to renderers,
with managed-agent delivery disabled. No history, MCP, long-poll, receipt, push,
agent inbox, presence, room-sync cursor or message-creation path carries them.

## Expiry and cost

`shared/room-typing.mjs` defines the common limits: five-second TTL, 2.5-second
active-pulse interval, one-second background sweep, four sources per person/room,
512 people per room, 10,000 person/room entries per API process, and 80-character
names. There are no migrations, persistent state, new dependencies or draft logs.

Only actual input starts reporting; restoring a nonempty draft does not.
A short burst costs one POST, existing session/room authorization reads, one local
emission, at most one bridge notification and one hint per eligible other-person
stream. Continued input coalesces to at most one active report every 2.5 seconds.
A trailing report contains only the remaining lifetime since the last input.
Successful send, empty input, room changes, disposal and page exit attempt one
stop; failures never interrupt composing or sending.

The server limiter is per account and canonical room **per process**. Rate and
sequence state is not replicated. Simultaneous requests on different processes
may each pass. Excess hints return 204 silently. Receivers ignore duplicate or
reordered source sequences. Each composer has an independent source, so stopping
one device does not erase another active source. Stops retain a short sequence
guard, and all maps have caps; a timer sweeps expired server entries off the
request path.

Every receiver keeps a source for `min(ttl_ms, 5000)` from its own receipt time.
Clients never compare the server's `expires_at` with their clock; absolute expiry
is only used on the server/bridge. One timeout targets the earliest active source
expiry, with none when idle. Lost stops cannot leave a permanent indicator.
Disconnect, reconnect, sign-out and room changes clear receiver state. There is
no snapshot or replay: another person reappears on their next active pulse.
Native long-poll fallback has no typing data. Hints may disappear during overload,
network loss; message delivery does not depend on their success.

## Placement and accessibility

The shared component is an absolute 12px-high, single-line, clipped text span
with pointer events disabled, a polite status role, escaped names and no animation.
Its 11px text and `--text-tertiary` colour match the existing shared conversation
header's secondary text. Refreshing the same names does not change its text.
Nothing is inserted into layout when typing starts or stops.

- **Web:** the textarea's relative wrapper anchors the span at top 0, inset 18px.
  It occupies the existing 12–16px textarea top padding, below any reply preview
  and above input text, including compact/mobile layouts.
- **Desktop:** the existing input grid anchors it at top -5px, inset 48px left and
  94px right. Its 12px height spans the existing 7px row gap/form padding and 8px
  textarea top padding. It stays within the textarea column, clear of the agent,
  attachment and send controls, and below attachment/reply cards.

There is no permanently reserved empty row, new composer padding or timeline
overlay. DesktopRoomShell.vue is unchanged. Actual geometry, focus and small-screen
legibility still require the independent live check below.

## Repeatable verification

Use a disposable PostgreSQL 16 database with this repository's migrations applied:

```sh
TEST_DB_URL=postgresql://test:test@localhost:5432/letagents_test \
  node --import tsx --test --test-concurrency=1 \
  src/api/__tests__/room-typing.test.ts \
  src/api/__tests__/room-message-routes.test.ts \
  src/api/__tests__/sse.test.ts \
  src/api/__tests__/event-bridge.test.ts \
  src/api/__tests__/event-bridge-domains.test.ts \
  src/api/__tests__/event-bridge-pg.test.ts
npm run test:web
npm --prefix apps/desktop run test:renderer
node --import tsx --test --experimental-test-module-mocks --test-concurrency=1 \
  apps/desktop/electron/__tests__/room-typing.test.ts \
  apps/desktop/electron/__tests__/room-stream-fallback.test.ts \
  apps/desktop/electron/__tests__/ipc-registration-domains.test.ts
```

CI explicitly registers the server/bridge suite. It covers clock expiry,
coalescing, reordered starts/stops, memory bounds and sweep, authority, aliases,
rental/private refusal, self filtering, real SSE/poll handlers, no broker cursor,
backpressure, reconnect and native managed-agent exclusion. A real two-process
PostgreSQL bridge test compares message, receipt, push-queue and presence-table
digests before and after. Client tests exercise stream/composable state and
source contracts; they do not claim browser interaction or geometry validation.

For live review, use one ordinary room and accounts Ada, Bea and Cy, with Bea
signed in on two devices. Open the main composer on desktop and web, type without
sending, then send, clear, stop for five seconds, leave, disconnect and reconnect.
Verify one/two/several names, no self on either Bea device, no restored-draft pulse
and independent device stops. Repeat with a private room, a denied reader, a
rental room, local desktop room and native thread composer. Check narrow widths,
reply/attachment cards, textarea growth/scrolling, keyboard focus, reduced motion
and unchanged timeline/composer geometry. Agent long-poll/SSE must stay parked;
agent reads, receipts and push counts must be unchanged.
