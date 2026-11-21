# Supervisor daemon: evaluation of a rewrite in Rust

Status: **findings and a spike, no product change**

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

The spike in [Spike results](#spike-results-2026-11-21) supports this. For the
same work on the same data, Rust used about the same CPU as TypeScript, because
the cost is SQLite and JSON, and Node already runs both in native code. Rust's
real gains were memory (5 MB idle, against 127 MB for the TypeScript daemon on
an empty state folder) and start-up time. Those gains are real, but no user
problem today depends on them.

The spike also showed that a later move is possible. Rust read the v52
database byte for byte as TypeScript does, and the two daemons' singleton locks
exclude each other. So a staged hand-off between the implementations can work.

Revisit when the conditions in [When to revisit](#when-to-revisit) are true.

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
| Less memory | Real. Measured: the spike uses 5 MB idle. The TypeScript daemon uses 127 MB on an empty state folder, 58 MB in long use on one Mac, and 476 MB after it starts on a 38 MB database. If the adapters stay in a Node process, most of the saving goes away. |
| Less CPU | None measured. For the same store-level work, Rust and TypeScript used the same CPU within 10% (see the spike results). |
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

## Spike results (2026-11-21)

The spike is in `spikes/rust-daemon/`, at the repository root. It is not built
by CI and not shipped.

### What the spike is

A Rust program (1,192 lines; `libc`, `rusqlite` with bundled SQLite and
`serde_json`; 36 crates in `Cargo.lock`; a 2.4 MB binary). Each locked crate
was published at least 14 days before the spike. Cargo does not do that by
itself: it picked six indirect crates from the last 14 days (two of them from
the same day), and the spike pins them back by hand. This is the gap in the
supply-chain rules that "Costs and risks" names. The program:

- takes the singleton lock as `daemon/singleton.ts` does on macOS
  (`O_EXLOCK | O_NONBLOCK`, then the durable `daemon.lock.generation` counter);
- opens `daemon-state.sqlite` with the same pragmas, requires WAL and refuses any
  schema other than v52;
- serves the control socket with the same framing, the 64 KiB cap, the protocol
  version check and the same error texts;
- answers five methods: `daemon.negotiate`, `daemon.status`, `manifest.list`,
  `manifest.watch_state` (long poll, 150 ms coalescing, per-agent cache on
  `agent_state_versions`, `changed_only`) and
  `manifest.update_workplace_liveness` (one write, so that a watch has changes).

`manifest.list` in the spike gives the stored entry
(`ManifestStore.load`). The TypeScript daemon sends a derived view
(`entriesWithDerivedLiveness`), which also needs live in-memory state: provider
handles, credentials, delivery turns and inbox receipts. The spike has none of
that state, so it does not make the view.

The plan said "a copy of a real database" and "the edge harness". The spike used
a synthetic database instead, so that no user data is in the measurements. It
did not use the edge harness, because the harness is on `feat/modern-daemon`
and its scenarios need providers.

### Method

- `bench/seed.ts` uses the real TypeScript stores to write 218 stopped agents in
  12 rooms. Each agent has 40 activity events (every tenth has a 24 KB payload)
  and 40 inbox receipts. Some agents have avatars, and 1 in 9 is failed, with a
  reconciliation record, a terminal and a notice. The database is 38 MB. The
  seed also saves what `ManifestStore.load` reads back, as the reference.
- `bench/compare.mjs` starts each daemon on a fresh copy of that folder and uses
  only the control socket, with one connection per request, as the desktop app
  does. The TypeScript daemon is `dist-daemon/main.js` under the installed
  Electron program in Node mode (Node 24.19.0, SQLite 3.53.3), as in production.
- `bench/ts-store.ts` does the same store-level work as the spike, in-process,
  on the real `ManifestStore`. This is the like-for-like test. It favors
  TypeScript, because it has no socket and no request parsing.
- `bench/lock-and-empty.mjs` measures the TypeScript daemon on an empty state
  folder, and it tests the lock between the two implementations.
- Host: Apple M5 Pro, 24 GB. One run of each. Expect some variation.

### Parity

| Check | Result |
|---|---|
| `manifest.list` summary, all 218 entries, against `ManifestStore.load("summary")` | Byte-identical JSON |
| `manifest.list` full (24 MB), against `ManifestStore.load("full")` | Byte-identical JSON |
| `daemon.status` keys | No TypeScript key is missing. The spike reports all delivery capabilities as `false` |
| TypeScript daemon running, Rust daemon started on the same folder | Rust refuses: "A supervisor daemon already owns this host lock." |
| Rust daemon running, TypeScript daemon started on the same folder | TypeScript refuses with the same message |

The parity covers the branches that the seed uses. It does not cover provider
references, turn-control records, `daemon_inbox` delivery, local rooms or
image avatars. To match the TypeScript output, the spike needed its own copy of
one shared module (`shared/agent-avatar.mjs`, 114 lines of Rust).

### Black box: the two daemons over the socket

| Measurement | Rust spike | TypeScript daemon |
|---|---|---|
| Start-up to the first `daemon.negotiate` answer (3 runs) | 24 to 26 ms | 2.8 to 4.7 s (625 to 665 ms on an empty folder) |
| Resident memory, 5 s after start | 4.7 MB | 476 MB (127 MB on an empty folder) |
| Idle CPU over 10 s | 0 | 0 |
| `manifest.list` summary: p50, size, CPU for 30 calls | 20 ms, 1.1 MB, 0.48 s | 157 ms, 9.8 MB, 4.14 s |
| `manifest.list` full: p50, size, CPU for 10 calls | 103 ms, 24 MB, 0.59 s | 245 ms, 33 MB, 1.98 s |
| 30 s watch load: about 147 writes, a `changed_only` watcher, CPU | 0.54 s (1.8% of one core) | 3.36 s (11.2%) |
| Watch: entries in each wake, bytes in each wake | 0.99, 7.8 KB | 1.00, 28 KB |
| Peak resident memory during the run | 298 MB | 572 MB |

These rows are not a language comparison. The TypeScript daemon does more work:
its list and watch build the derived view for each entry, and the view is about
nine times the stored data (9.8 MB against 1.1 MB). Its start-up also makes the
encrypted backup, compacts and checks the database. The spike does none of
these.

### Like for like: the same store-level work

| Work | TypeScript `ManifestStore`, in-process | Rust spike, over the socket |
|---|---|---|
| `manifest.list` summary, CPU for 30 calls | 0.49 s (p50 15.6 ms) | 0.48 s (p50 19.6 ms) |
| `manifest.list` full, CPU for 10 calls | 0.66 s (p50 49 ms) | 0.59 s (p50 103 ms) |
| 147 liveness writes, each with one state-watch read | 0.10 s | 0.54 s |
| Resident memory after the reads | 571 MB | 295 MB |

For the same work, the CPU is the same within about 10%. In both languages, the
cost is SQLite and JSON, and Node already runs both in native code (`node:sqlite`
is C, `JSON.stringify` is C++). The Rust write figure is higher because it also
counts the socket, the request parsing, and the full entry (about 110 KB) that
each write sends back. The Rust latencies include the time the test client takes
to parse the reply, so compare CPU, not latency. In both languages the peak
memory comes from holding the 24 MB full list as objects. A streaming encoder
would remove it.

### What the spike shows

1. **CPU: no gain.** A Rust daemon would not make the daemon's work cheaper.
2. **Memory and start-up: a real gain.** Idle memory drops from about 127 MB
   (empty folder) to 5 MB, and start-up from about 0.6 s to 25 ms. Today no
   user problem depends on either.
3. **A staged move is possible.** The database is readable byte for byte,
   and the singleton lock works across the two implementations. Both are
   needed for a hand-off between them.
4. **The port is mechanical but large.** Five methods at store level took
   1,192 lines and one copied shared module. The view layer, the providers,
   migrations, backup and the Windows pipe are not in the spike.

### Two findings for the TypeScript daemon

These are not about the language. Each can be a small task:

- After start-up on the 38 MB database, the TypeScript daemon holds 476 MB,
  against 127 MB on an empty folder. The cause is not traced yet. The start-up
  backup and compaction are the first places to look
  (`daemon/state-recovery-backup.ts`, `daemon/daemon-state-maintenance.ts`).
- In summary mode, the derived view of `manifest.list` is 9.8 MB, while the
  stored data is 1.1 MB. The inbox receipts in the view are the likely cause.

### How to run it again

From the repository root, with the dependencies installed and the daemon built
(`npm run build`, then `npm --prefix apps/desktop run build:electron` and
`npm --prefix apps/desktop run build:daemon`):

```bash
cargo build --release --manifest-path spikes/rust-daemon/Cargo.toml
ELECTRON_RUN_AS_NODE=1 /Applications/LetAgents.app/Contents/MacOS/LetAgents --import tsx spikes/rust-daemon/bench/seed.ts spikes/rust-daemon/.run/seed/.letagents spikes/rust-daemon/.run/reference
node spikes/rust-daemon/bench/compare.mjs 30
ELECTRON_RUN_AS_NODE=1 /Applications/LetAgents.app/Contents/MacOS/LetAgents --import tsx spikes/rust-daemon/bench/ts-store.ts 147
node spikes/rust-daemon/bench/lock-and-empty.mjs
```

The runs write to `spikes/rust-daemon/.run/`, which git ignores. Set
`LETAGENTS_ELECTRON` to use another Electron program.
