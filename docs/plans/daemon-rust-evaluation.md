# Supervisor daemon: evaluation of a rewrite in Rust

Status: **findings only, no product change**

This document records what a rewrite of the desktop supervisor daemon
(`apps/desktop/daemon/`) in Rust would involve, and what it would give us.

Measured on 2026-11-21 against `staging` at `866b6469a`. The modern-daemon
program on `feat/modern-daemon` was read at the same date. Paths are relative to
`apps/desktop/` unless they start with `shared/` (repository root) or `docs/`.

## Recommendation

Do not rewrite the daemon in Rust now.

The daemon is not a self-contained program. It loads about 38,600 lines of
TypeScript provider adapters and the sealed MCP tool runtime into its own Node
process. A Rust daemon must either rewrite those adapters too (about 100,000
lines in total), or keep a Node process next to it. With a Node process next to
it, we keep the Node runtime and we add a new process boundary on the busiest
path: provider stream events.

The daemon does IO and state transitions, not computation. The performance
problems we had came from the design, and we fixed them in TypeScript. At the
same time the design changes quickly: 419 commits in 90 days, and the
modern-daemon program is still removing modes and plans a new schema. A rewrite
now aims at a target that moves.

Revisit when the conditions in [When to revisit](#when-to-revisit) are true.
If we want numbers before that, do the small spike in
[A spike that gives real numbers](#a-spike-that-gives-real-numbers).

## What the daemon is today

| Item | Value |
|---|---|
| Source | 199 files, 62,069 lines of TypeScript (no tests) |
| Tests | 128 test files, 89,383 lines; about 2,683 s of CI time (`scripts/daemon-test-weights.json`) |
| Loaded at run time | 4 provider adapters, about 38,600 lines (`electron/main/agents/`, moving to `provider-runtime/` on `feat/modern-daemon`) |
| Shared modules it imports | 41 modules from `apps/desktop/shared` and `shared/*.mjs`, about 8,600 lines |
| Package dependencies | Only `node:*` built-in modules and `zod` (8 files) |
| Runtime | The Electron program in Node mode (`ELECTRON_RUN_AS_NODE=1`, `electron/main/supervisor-daemon/spawn-environment.ts:12`) |
| Platforms | macOS and Windows only (`daemon/platform.ts`) |
| Storage | One SQLite file, schema version 52, about 73 live tables, 62 indexes, 40 triggers |
| Control API | 56 methods, JSON lines on a Unix socket or a Windows named pipe, protocol version 3 |
| Age and change rate | First commit 2026-07-14. 419 commits in 90 days, 48 in 30 days. +3,548 / -846 source lines in 30 days |
| Memory, one Mac, 2026-11-21 | 58 MB resident, 0% CPU, after 2 days of run time (agent count not known) |
| Memory, PR #1882 | 70 MB live heap after a full GC, with 12 agents and 218 entries |

### Approximate split of the 62,069 lines

The split is from file names, so it is an estimate. SQL is in many stores, so
the storage row is too low.

| Area | Files | Lines |
|---|---|---|
| Provider execution, streams, turn control, capture | 28 | ~13.4k |
| Delivery, inbox, attachments, room moves | 45 | ~12.1k |
| Storage: schema, migrations, durability, shadow and binding stores | 29 | ~11.7k |
| Manifest store, read models, state watch | 24 | ~6.4k |
| Approvals, delegation, host tool rules | 20 | ~4.5k |
| Cloud HTTP, worker authority and custody | 7 | ~4.1k |
| Control socket, main, wiring, types | 20 | ~3.9k |
| Recovery, reconciler, lifecycle | 14 | ~3.1k |
| Workspace and git | 5 | ~1.1k |
| Other (pacer, latency, gates) | 7 | ~1.7k |

## What a rewrite must reproduce

### 1. The code it loads at run time

The daemon has no provider logic of its own. It loads it with `import()`:

- The four adapters, from `../dist-electron/main/agents/*-provider-adapter.js`
  (`daemon/provider-action-port-router.ts:655-680`).
- The MCP tool executor from the npm `letagents` package, after a hash check of
  its whole file tree (`daemon/supervised-tool-runtime.ts:72-138`).
- `electron/main/rooms/local-supervision-runtime` (`daemon/local-room-runtime.ts:25`).

Each adapter speaks a different protocol:

| Provider | How the adapter drives it |
|---|---|
| Claude Code | Child process, stream-json on stdin and stdout (`claude-code/launch-args.ts:247-250`) |
| Codex | `codex app-server`, JSON-RPC over a local WebSocket (`codex-app-server.ts:477-481`) |
| Cursor | One `cursor-agent` process for each turn, optionally under `sandbox-exec`, stream-json (`cursor/turn-wrapper-start.ts`) |
| Open Model | `opencode serve` on loopback, HTTP and server-sent events (`opencode-server-client.ts:616-647`) |

This gives two possible designs. Both are expensive:

- **Rust for all of it.** Rewrite the daemon, the four adapters and the tool
  executor: about 100,000 lines, plus the shared modules. Electron also uses the
  adapters, so either Electron calls the Rust code, or we keep two copies.
- **Rust core with a Node process for the adapters.** The Rust daemon starts a
  Node process (still the Electron program in Node mode) to host the adapters.
  Each stream event, approval and turn control then crosses one more process
  boundary. PR #2068 notes that the one adapter contract is still not small. The Node runtime stays, so we lose the main reason to leave it.

### 2. The storage on user machines

- Existing databases are opened in place. `daemon/daemon-state-database/version-gate.ts`
  checks the exact table shape for many versions and reads JSON inside columns.
- The migration chain goes from v1 to v52.
- Every connection uses WAL, `synchronous=FULL`, `foreign_keys=ON` and
  `secure_delete=ON`. There are 333 hand-written transaction sites, 91 of them
  `BEGIN IMMEDIATE`.
- There is an AES-256-GCM encrypted logical backup (`daemon/state-recovery-backup.ts`).

`rusqlite` can do all of this. But the Rust daemon must read the v52 shape
exactly, or the modern-daemon `task_3` clean-slate schema must come first. A
rewrite before `task_3` writes the storage layer twice.

### 3. The wire contracts

- 56 control methods with no message schema. The router parses parameters with
  hand-written helpers and picks the method with an `if` chain
  (`daemon/control-request-router.ts:145-209`). The contract is the TypeScript
  code itself, so a second implementation must copy it line by line.
- Other clients use the same socket: MCP workers (`src/mcp/server/runtime/supervisor-bridge.ts`)
  and the local board (`shared/local-board-owner.mjs`).
- Start-up uses a Node IPC side channel to pass the state recovery key
  (`daemon/state-recovery-key.ts`). A Rust daemon needs a new channel for this,
  and Electron must change too.
- The version hand-off (`daemon.negotiate`, `daemon.prepare_handoff`) must work
  between the last TypeScript daemon and the first Rust daemon in both
  directions, because an update can be rolled back.

### 4. Logic that is shared with Electron and the MCP server

These modules are used by the daemon and also by Electron, the renderer or the
MCP server (counts are files in Electron main / renderer / `src`). A Rust daemon
needs its own copy of each, and the copies must stay equal:

| Module | Electron / renderer / src |
|---|---|
| `room-expressions` | 6 / 8 / 11 |
| `owner-private-fs` | 18 / 0 / 2 |
| `process-tree` | 12 / 0 / 0 |
| `agent-avatar` | 10 / 0 / 1 |
| `letagents-home` | 10 / 0 / 3 |
| `room-api-origin` | 4 / 0 / 5 |
| `room-agent-work` | 4 / 1 / 4 |
| `execution-delegation-decision` | 0 / 0 / 7 |
| `daemon-endpoint` (pipe name, HMAC proof) | 3 / 0 / 2 |

### 5. The tests

- 117 of 128 test files import internal classes and build them directly.
  About 23 drive the real socket, but they subclass `SupervisorDaemon` in the
  test process and inject TypeScript fakes. Only one test starts `daemon/main.ts`
  as a separate process. None of these tests can check a Rust daemon.
- The useful asset is the black-box edge harness on `feat/modern-daemon`
  (PR #2055 and the PRs after it). It starts the compiled daemon as a child
  process, and `LETAGENTS_EDGE_DAEMON_CMD` / `LETAGENTS_EDGE_DAEMON_ARGS` replace
  that program. It replays recorded Codex, Open Model, Claude Code and Cursor
  transcripts against a fake room server. It has 22 tests: Codex 7, Open Model 7, Claude Code 5, Cursor 3. That is a
  good gate, but it covers a small part of the 56 methods and their failure paths.

## What Rust would give

| Possible gain | Size of the gain here |
|---|---|
| Less memory | Real but small. The daemon is 58 to 70 MB today. A Rust daemon could be 15 to 30 MB. If the adapters stay in a Node process, most of that saving goes away. |
| No GC pauses, less allocation | PR #1882 measured 100 MB/s of allocation, but the cause was full re-reads and 4 MB JSON pushes. That PR fixed it in TypeScript. |
| No event-loop stalls from SQLite | SQLite is synchronous in Rust too. The fix is the same in both languages: batches (PR #1668) and work off the main thread. Rust makes threads easier and safer. |
| One program to ship | No gain. We ship the Electron program, and it already runs the daemon in Node mode. A Rust program is one more binary to sign and notarize on macOS. On Windows it is one more unsigned exe. |
| Safer state machines | Real. The daemon is mostly fences, leases and state transitions. Rust enums and ownership catch more mistakes at compile time than TypeScript does. But the TypeScript code already has 89,000 lines of tests for this. |
| Windows native code | Real but small. Rust (`windows-sys`) could replace the two sealed C helpers (named pipe client, process tree). They are 337 and 730 lines of C, and they work. |
| Crash isolation from adapters | Possible with the core-plus-Node design. But a separate adapter process gives the same isolation in TypeScript. |

## Costs and risks

- **Size of work.** The daemon took about four months to build, mostly by one
  author. A rewrite of the daemon alone is of the same order. With the adapters
  it is about twice that. During the rewrite, every daemon fix must be done in
  both languages, or daemon work must stop.
- **A moving target.** The modern-daemon program is deleting delivery modes
  (PR #2064: -8,606 lines), moving the adapters (PR #2067) and setting the
  adapter contract (PR #2068). The next steps change the schema (`task_3`). A
  rewrite that starts now must follow all of these.
- **No Rust in the project.** There is no Cargo file, no Rust toolchain and no
  Rust CI step. The supply-chain rules (`scripts/verify-dependency-age.mjs`,
  `scripts/verify-workflow-supply-chain.test.mjs`, signature checks) cover npm
  and GitHub Actions only. Cargo needs the same rules: a pinned toolchain, a
  dependency age gate, `cargo deny` or the same, and reproducible builds like the
  sealed C helpers.
- **People.** In 90 days one author made 383 of the 419 daemon commits. A second
  language makes that dependency on one person stronger, unless a second
  person who knows Rust joins.
- **Upgrade risk on user machines.** The hand-off from the last TypeScript
  daemon to the first Rust daemon, and back on a rollback, is the riskiest step.
  It runs on every user's machine, with their real database and live agent
  processes.

## When to revisit

Look at this again when most of these are true:

1. `feat/modern-daemon` is merged into `staging`, and `task_3` (clean-slate
   schema) is done.
2. The adapters run behind a narrow contract that can cross a process
   boundary, or they already run in their own process.
3. The edge harness covers each control method that Electron and the MCP
   workers call, with a fake room server, and it runs in CI on macOS and Windows.
4. The control methods have a schema (for example zod schemas that generate JSON
   Schema), so a second implementation has a contract to follow.
5. We have a measured problem that Node cannot fix. Examples: daemon memory
   on 8 GB machines (`daemon/convergence-pacer.ts` already slows launches there),
   GC pauses that delay stream events, or slow start-up.
6. A second person on the team can review Rust.

## A spike that gives real numbers

If we want numbers before we decide, a spike of one to two weeks can give them
without risk to users. It ships nothing.

1. A Rust program that opens the control socket (Unix socket only), takes the
   singleton lock with the same file rules (`daemon/singleton.ts`), and answers
   `daemon.negotiate`, `daemon.status`, `manifest.list` and `manifest.watch_state`.
2. It opens a copy of a real v52 `daemon-state.sqlite` read-only and serves the
   manifest from it.
3. Run the edge harness `negotiate` and state-watch checks against it with
   `LETAGENTS_EDGE_DAEMON_CMD`.
4. Measure against the TypeScript daemon, with the same database of 218 entries:
   resident memory, start-up time to `daemon_ready`, and CPU for 30 s of
   `watch_state` with changes.

If the spike shows a large gain on a problem that users have, write a plan for
a staged move. Otherwise close the question.
