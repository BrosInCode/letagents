# Rust daemon spike

Spike only. Not built by CI, not packaged, not shipped.

A Rust stand-in for five control methods of the desktop supervisor daemon
(`apps/desktop/daemon/`), with benchmark scripts that compare it with the
TypeScript daemon. The results and the decision are in
[docs/plans/daemon-rust-evaluation.md](../../docs/plans/daemon-rust-evaluation.md),
section "Spike results". The commands to run it again are there too.

| Path | Content |
|---|---|
| `src/main.rs` | Singleton lock, database open, control socket, `daemon.*` and the liveness write |
| `src/manifest.rs` | Port of the manifest read (`MANIFEST_ENTRY_SELECT`, `projectionFromRow`, `composeDaemonManifestEntry`) |
| `src/watch.rs` | Port of `manifest.watch_state` |
| `src/avatar.rs` | Copy of `normalizeAgentAvatar` from `shared/agent-avatar.mjs` |
| `bench/seed.ts` | Synthetic 218-agent state folder, written with the real TypeScript stores |
| `bench/compare.mjs` | Both daemons over the socket: parity, start-up, memory, reads, watch load |
| `bench/ts-store.ts` | The same store-level work in TypeScript, in-process |
| `bench/lock-and-empty.mjs` | TypeScript start-up on an empty folder, and the lock across implementations |

Runs write to `.run/`, which git ignores. macOS only.
