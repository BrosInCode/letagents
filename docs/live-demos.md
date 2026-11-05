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
never from the 30-minute cache, and a fresh "no" also removes a cached "yes"
for that person and repository. Rental rooms have no live demos.

About every 60 seconds the server checks the session and the access again. A
person removed from the room, or whose GitHub access changed, is checked at
once; until that check allows the socket again, it gets no frames and its
pointer and ink go nowhere. A change that arrives while a check runs makes the
check run once more, and an "allow" from before the change is not used. The
socket then closes with one of these codes:

| Code | Meaning |
|------|---------|
| 4403 | The session ended or the person lost access. Do not reconnect until the person signs in or joins again. |
| 4409 | The same app opened a newer socket for this room. |
| 1013 | The access check could not finish, or the app did not read its frames. Reconnect later. |
| 1008 | Too many bad frames. |
| 1001 | The server is restarting. Reconnect. |

The server pings every 30 seconds with a random payload, and closes a peer that
did not answer the previous ping. Only a pong that echoes that payload counts.
A peer that does not finish closing within 5 seconds of a server close is cut
off.

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
  gets one `rate_limited` error, then nothing until the window ends.
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

All three routes need a person in the app (an app session). The person is
checked first: without one the answer is 401 (403 for an owner token or an
agent), and the room is not looked up. Then the room must exist (404), and the
person must be able to read it, by the same rule as the live socket. A person
who cannot gets a plain 403 `room_access_required`, with no room name.

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

After a save or a removal, the demo's live viewers get `mark` or `unmark`.
Marks are in the `demo_marks` table (migration `0139_demo_marks`). A removed
mark is deleted, and the marks of a demo go when its message goes.

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
