# Open Model Codex-adapter parity validation

Status: **capability-gated** (task 39)

Scope: the existing Electron-owned Open Model runtime, which launches a
dedicated Codex app-server with an OpenAI Responses-compatible provider. This
validation does not port Open Model into daemon convergence.

## Verdict

Open Model may continue to advertise its app-owned managed runtime and bounded,
redacted Codex activity stream. It must not advertise durable supervised-runtime
parity yet. Sharing the Codex launch engine proves protocol compatibility, but
the existing Open Model path persists only `server_pid`; it does not persist the
PID birth/command identity required to fence PID reuse, and the daemon rejects
non-`codex` providers rather than selecting an Open Model adapter/configuration.

The Add Agent UI therefore exposes the Supervised lifecycle only for providers
that advertise the explicit `supervised_runtime` capability. Open Model does not
advertise it.

## Evidence matrix

| Cell | Existing Open Model path | Evidence / gate |
| --- | --- | --- |
| Dedicated native launch | Pass | `openModelCodexLaunch` feeds a dedicated Codex app-server. |
| Provider policy | Pass for the app-owned path | The selected Codex policy remains provider-native; no LetAgents permission translation is introduced. |
| API-key isolation | Pass for the dedicated API-key field | A real Codex CLI 0.144.1 app-server launched against a loopback fixture kept the dummy sentinel out of `ps` argv/stdout/stderr and sent it only as the provider `Authorization: Bearer` header. `shell_environment_policy.exclude` unconditionally removes the key variable from model-run shell environments. |
| Endpoint URL isolation | Gap | The full `base_url` is necessarily present in argv. Current URL validation permits userinfo and does not define a query-secret policy, so credentials embedded in the URL would be exposed via `ps`; task 40 tracks hardening. |
| Durable PID birth identity | Gap | Session state stores `server_pid` but no birth/command identity. PID-only liveness and signalling cannot authenticate the original child after PID reuse. |
| Observable terminal ordering | Partial / gated | Child exit is observed, but RPC-loss handling is not joined to a persisted birth-identity fence, so it cannot satisfy P1c replacement authority. |
| Exact-thread continuation | Partial / gated | The live Electron Codex engine continues a thread while its app-server is available, but the Open Model path is not wired to the P1c adapter's durable attach/resume contract. |
| Bounded/redacted native stream | Pass | Open Model sessions use the shared Codex notification, transcript-summary, and output-redaction path. |
| Long quiet / slow-live request | Protocol pass; supervision gated | A live socket request timeout is not itself disconnect evidence, but the Open Model lifecycle still lacks the durable fence above. |
| Daemon restart/reattach | Gap | Daemon convergence explicitly has no provider port for `open-model`. |

## Regression anchors

- `apps/desktop/electron/__tests__/open-model.test.ts` proves key/argv
  separation, unconditional shell-env exclusion, and the absence of the
  `supervised_runtime` advertisement.
- `apps/desktop/electron/__tests__/desktop-managed-agents.test.ts` proves
  app-server output redaction, including inherited and split secrets.
- `apps/desktop/electron/__tests__/codex-provider-adapter.test.ts` remains the
  reference P1c contract for birth identity, exact-thread resume, RPC-loss
  fencing, terminal ordering, bounded stream, and slow-live behavior. Those
  tests do not automatically confer parity on the separate Open Model runtime.
- `apps/desktop/renderer/__tests__/managed-agents.test.ts` proves that app-owned
  runtime availability does not imply durable-supervision availability.

The live credential cell used the exact `openModelCodexLaunch` overrides, a
unique dummy key, and a loopback Responses fixture (no paid endpoint). The real
app-server reached `/readyz`, accepted the custom provider/wire configuration,
kept the sentinel out of its 522-character process command and captured output,
then sent it only in the fixture's `/v1/models?client_version=0.144.1` bearer
header. Process-group SIGTERM removed the child without an orphan. This proves
credential transport, not durable lifecycle parity. A full model-driven shell
turn was not required for the NO-GO verdict and remains unadvertised empirical
evidence; the unconditional exclusion is retained as the regression contract.

## Follow-up boundary

A separate accepted implementation task is required to add Open Model to daemon
convergence. It must carry the provider configuration/key into a dedicated
adapter without persisting or logging the key, persist PID birth identity,
prove exact-thread attach/resume and RPC-loss fencing against a loopback
Responses fixture, and only then add `supervised_runtime` to Open Model.
