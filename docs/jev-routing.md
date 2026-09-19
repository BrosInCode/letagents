# Smart conversation routing (Beta)

Desktop 0.1.54 adds **Room settings → Smart conversation routing · Beta**,
powered by Jev. Every room starts with it off, including existing rooms and
new focus rooms. An authenticated room admin can enable or disable it. Agent
credentials cannot change it. Local-only rooms do not expose this cloud feature.

The first beta selects responders for untagged human messages in rooms with
3–40 agents. Explicit mentions, broadcasts, replies to agents, threads, and
task-owner instructions retain deterministic routing. Agent replies do not
start another Jev election: this beta cannot create an autonomous response loop.

Enabling the setting discloses that recent room messages, agent names, models,
and role descriptions are sent to Jev. Context is bounded; prompt-only, system,
GitHub, failure, and rental-restricted messages are excluded. The current message
and its quoted reply are checked again before inference. Room flags are independent.

## Operations

Set `LETAGENTS_JEV_ROUTING=active` and provide `TYPESAFE_API_KEY` (preferred) or
`AI_GATEWAY_API_KEY` on the API server. Missing credentials keep deterministic
routing active and make the room switch unavailable. Keys stay on the server.

`LETAGENTS_JEV_ROUTING=off` is the global disable and the default. `shadow`
compares decisions only for already opted-in rooms; it never defers normal
delivery. Apply environment changes by restarting the API. Disabling an
individual room stops new evaluations; queued work uses its captured standard
fallback. An inference already in flight can finish. Timeouts and invalid
responses also use standard routing.

Deploy migrations and the API before releasing the desktop. Use desktop 0.1.54
and standalone MCP 0.12.23 or later for Jev rooms. Older standalone MCP clients
can advance their read cursor on their own writes, which can skip an intervening
pending message. The new runtime advances read progress only from reads.

## Delivery and recovery

Messages and routing jobs commit together. A leased worker evaluates outside
the send transaction, then commits recipients and completion atomically. A
stale worker cannot complete a replacement worker's lease. Abandoned work is
eligible for recovery after 45 seconds; repeated failures fall back to standard
routing. Human transcript reads remain immediate.

Worker history, polling, and stream checkpoints stop before the earliest
incomplete active job in the same database snapshot. Later messages cannot
overtake it. Worker streams retain blocked frames and recheck the database;
poll retries use the existing durable cursor. Correctness does not depend on
receiving a completion notification, and there is no separate delivery ACK.

Verification:

```sh
TEST_DB_URL=<disposable-test-database> node --import tsx --test --test-concurrency=1 src/api/__tests__/jev-room-routing-db.test.ts
node --import tsx --test src/api/__tests__/jev-conversation-routing.test.ts src/api/__tests__/room-message-routes.test.ts src/api/__tests__/legacy-project-message-routes.test.ts src/api/__tests__/event-bridge.test.ts
npm run test:mcp
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run test:renderer
```

The database test resets its target database. Never point it at application data.
