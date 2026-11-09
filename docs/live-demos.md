# Live demos

People in a room who have the same HTML demo on screen see each other: who is
viewing, each person's pointer, and strokes while someone draws. Finished
strokes and pins are saved, so a person who opens the demo later sees them.
This page describes the server side. The wire format is `shared/live-demo.mjs`.

A demo is one attachment of one room message. Its key is
`<message id>/<attachment id>`, for example `msg_12/att_1`.

## The live socket

`GET /rooms/<room>/live` upgrades to a WebSocket with the subprotocol
`live_demo_v1`. The desktop app opens one socket per room, from its main
process. The room id may contain slashes, as in the other room routes. Rooms
are found by id (a focus room also by its locator), never by invite code: an
invite code is a secret for joining, and live demos are for people already in
the room. The marks routes find rooms the same way.

The app can send `X-LetAgents-Live-Client: <id>`, an id for one app run and
room (1 to 64 characters of `A-Z a-z 0-9 _ -`). A new socket with the same
account, room and id replaces the older one at once: the older socket closes
with 4409 and leaves presence, so a person never shows twice after a reconnect.

The server checks these before the upgrade. A refusal is a plain HTTP answer
with a JSON body `{ error, message }`, and no socket opens:

| Check | Refusal |
|-------|---------|
| The path is not `/rooms/<room>/live` | 404 |
| The request has an `Origin` header (a web page or an extension) | 403 |
| No `Authorization: Bearer` header (a cookie is not enough) | 401 |
| The subprotocol `live_demo_v1` is not offered | 400 |
| The client id header is not valid | 400 |
| The process has 2,000 sockets (closing ones included) and handshakes open | 503 |
| The bearer is not an app session (owner tokens and agent bearers are not) | 401 |
| The room does not exist | 404 |
| The account has 4 sockets open in this room, or 16 in all rooms | 429 |
| The person cannot read the room | 403 (503 when GitHub did not answer) |

A socket that the same app replaces does not count toward the 4 and the 16.

"Can read the room" is the same rule as the room's messages: the members of a
room that is not tied to a repository (a focus room uses its parent), or the
GitHub role for a repo room. At the upgrade the GitHub role is asked afresh,
never from the 30-minute cache. A fresh "no" also removes a cached "yes" for
that person and repository, and a check that started before it can neither
cache its "yes" nor share it with a later caller. If a removal or an access
change may concern an upgrade while its check runs, the server checks again
before it admits the socket. Rental rooms have no live demos.

About every 60 seconds the server checks the session and the access again. A
person removed from the room, or whose GitHub access changed, is checked at
once. Until that check allows the socket again, it gets no pointers, ink or
presence, and its own pointer and ink go nowhere; saved-mark changes and
errors wait in a queue of at most 64 frames and 256 KB (more closes the socket
with 1013, and the app reloads the marks when it reconnects). When the check
allows the socket, it gets the current viewers of each demo, then the queue;
when it refuses, the queue is dropped. A change that arrives while a check
runs makes the check run once more, and an "allow" from before the change is
not used. The socket then closes with one of these codes:

| Code | Meaning |
|------|---------|
| 4403 | The session ended or the person lost access. Do not reconnect until the person signs in or joins again. |
| 4409 | The same app opened a newer socket for this room. |
| 1013 | The access check could not finish, or the app did not read its frames. Reconnect later. |
| 1008 | Too many bad frames. |
| 1001 | The server is restarting. Reconnect. |

The server pings every 30 seconds with a random payload, and closes a peer that
did not answer the previous ping. Only a pong that echoes that payload counts.
The server answers the app's own pings itself (not `ws`), at most 5 in 10
seconds and only within the queue cap; each ping beyond that counts as a bad
frame. A peer that does not finish closing within 5 seconds of a server close
is cut off.

## Frames and limits

On connect the server sends `hello` with the connection id (`cid`), the name
and the colour. The app sends `join` and `leave` for each demo on screen, and
`cur` and `ink` while the pointer moves or the person draws. The server sends
`presence` to everyone viewing a demo when someone joins or leaves, relays
`cur` and `ink` to the other viewers of that demo only, and sends `mark` and
`unmark` when a saved mark changes. Nothing is relayed to another room.

On `join` the server checks that the demo key names an attachment of a message
in this room (one database read, then remembered for the socket). A refused
join gets an `error` frame with a `demo` field: `demo_not_found`,
`too_many_demos`, `rate_limited`, `demo_full` or `unavailable`.

- A frame is JSON text of at most 8 KB that `parseLiveClientFrame` accepts.
  Anything else is dropped. More than 10 bad frames in 10 seconds close the
  socket.
- A socket views at most 8 demos, and makes at most 20 joins in 10 seconds,
  a repeated join of a demo it views included. Every reply to the socket's own
  frames comes from a join, so this bounds them too. Past the limit the socket
  gets one `{ t: 'error', code: 'rate_limited', message, retry_after_ms }`
  with no `demo`, and nothing more until the window ends: every join in
  between is dropped, so the app sends again, after `retry_after_ms`, each join
  it has not seen its own presence for.
- A demo admits 64 viewers.
- Per socket and demo, the server relays at most 30 `cur` frames and 30 `ink`
  frames a second, and drops the rest without a reply. One `cur` `gone` after a
  shown pointer, and the `end` of an open stroke, always pass.
- A live stroke stops growing at 2,000 points.
- A socket with more than 64 KB waiting gets no `cur` or `ink` frames until it
  catches up. A frame that would make more than 256 KB wait closes the socket
  with 1013, so a socket that stops reading never holds more than that.

The hub keeps everything in memory in the API process. Production runs one API
container. The hub talks to a small per-room bus (`publish`, `subscribe`), so a
Postgres or Redis bus can join several processes later.

## Saved marks

Saving and removing need a person in the app (an app session). The person is
checked first: without one the answer is 401 (403 for an owner token or an
agent), and the room is not looked up. Then the room must exist (404), and the
person must be able to read it, by the same rule as the live socket. A person
who cannot gets a plain 403 `room_access_required`, with no room name.

Reading also takes an agent: a worker bearer, an owner token or another
signed-in agent. An agent's read uses the same room check as reading the
room's messages, and that check gives its own refusal. A request with no
sign-in still gets 401 first.

- `GET /rooms/<room>/demo-marks?demo=<key>` answers `{ marks }`, oldest first.
- `POST /rooms/<room>/demo-marks` with a `DemoMarkInput` body answers 201
  `{ mark }`. The demo must be an attachment of a message in this room (404).
  A demo keeps at most 500 marks (409 `demo_marks_full`) and 100,000 points
  over all its marks, a pin counting as one (409 `demo_marks_too_large`).
  Points are kept to a tenth of a demo pixel.
- `DELETE /rooms/<room>/demo-marks/<id>` answers 204. Only the author or a room
  admin may remove a mark (403).

Saves and removals are limited per account in the process: 20 at once, then 2
a second. Past that the answer is 429 `demo_marks_rate_limited` with
`Retry-After`. Reads are not limited.

A pin may save `anchor`: the element under it, as a CSS path (tag names, ids,
up to two classes, and a place among elements of its kind), and where the pin
sits in that element's box. The app asks main for it when the pin is placed.
Main runs the lookup in its own isolated world of the demo page and checks
each step of the path. A pin saved before the page answers (500 ms at most)
has no anchor. Strokes have none. A new mark whose anchor path is not in that
shape is refused (400 `invalid_mark`); marks saved before keep what they have.

After a save or a removal, the demo's live viewers get `mark` or `unmark`.
Marks are in the `demo_marks` table (migration `0140_demo_marks`). A removed
mark is deleted, and the marks of a demo go when its message goes.

## In the app

The card has one header row: the demo's name, a status dot with what the
connection means ("People here see your pointer"), a face for each person
(you first; click another face to ring that person's pointer), and the tools.

- **Pin** (P) works from any mode: the next click on the demo places a pin,
  whose number follows the pointer. Enter saves the note; the card goes back
  to what it was doing. Escape cancels.
- **Draw** (D) rings the demo in your colour and shows a bar inside the demo:
  your colour, Undo (⌘Z) and Done (Escape).
- **Marks** and **Send to thread** open panels over the demo from their
  buttons, so nothing above the demo moves it. Hovering a mark in the list
  lights it and dims the rest. A delete, or Clear mine, offers Undo for 6 s.
- A mark of yours shows at once and saves in the background. A save that fails
  keeps the mark on screen, dashed, and tries again when the link is back
  (a matching `mark` frame settles it, so a lost answer saves no second copy).
- **Send to thread** takes the picture without other people's pointers, the
  fade or the notes, and says when the card's clip or the window cut it. The
  reply carries the person's note, each pin's number, author and note, and who
  drew in which colour, because an agent cannot hover a pin.

## Agents and marks

- `read_demo_marks` (MCP, every agent kind, a read) takes a message id and,
  when the message has more than one HTML file, an attachment id. It answers
  the pins, numbered oldest first as people see them, with author, note, point
  and element, and each drawing as the box it covers, in demo space. One answer
  lists at most 200 pins (`first_pin` lists from a number on; `pin_count` and
  `next_first_pin` say what is left) and the newest 100 drawings, which come with
  the first page only. An element path in another shape is left out, not the pin.
- A desktop-supervised agent gets an HTML file on its wake-up message, or on a
  recent message, as a text file to read (like a `.log`). The note for that
  file names the message and attachment ids to pass to `read_demo_marks`. A
  local room has no marks, so its demos get no such note.

## Reverse proxy

A proxy in front of the API must pass the WebSocket upgrade for the live path.
For nginx:

```nginx
location ~ ^/rooms/.+/live$ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

Without the `Upgrade` and `Connection` headers, nginx sends a plain request and
the upgrade fails. The 30-second pings keep the socket inside the timeouts.
Pass `Upgrade` only on this path: the API answers every upgrade request on
another path with 404.

## Verification

Use a disposable PostgreSQL 16 database with this repository's migrations:

```sh
node --import tsx --test src/api/__tests__/live-demo-hub.test.ts \
  src/api/__tests__/live-demo-sockets.test.ts src/api/__tests__/live-demo-marks-routes.test.ts
TEST_DB_URL=postgresql://test:test@localhost:5432/letagents_test \
  node --import tsx --test --test-concurrency=1 src/api/__tests__/live-demos-db.test.ts
```

The first three need no database: the hub with fake sockets, the upgrade
handler on a real HTTP server with real `ws` clients (including probes with a
client that stops reading), and the marks routes with a stub store. The last
starts the real API server on a random port and checks the upgrade refusals,
cursors between two members, isolation from another room, and the marks
routes with their limits.
