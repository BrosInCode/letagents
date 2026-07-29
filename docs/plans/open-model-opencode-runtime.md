# Open Model OpenCode runtime

Status: **daemon-supervised**

Open Model agents run through a dedicated, pinned OpenCode server. They do not
use Codex as an execution engine and have no compatibility path to the removed
Codex-backed implementation.

## Product contract

- Users configure an OpenAI-compatible endpoint, model, and optional provider
  API key.
- OpenCode itself requires no LetAgents user account or OpenCode login.
- Release artifacts bundle the pinned OpenCode runtime. Development builds may
  resolve the same pinned version from `LETAGENTS_OPENCODE_BIN` or `PATH`.
- `apps/desktop/package.json#letagentsRuntime.openCodeVersion` is the single
  version authority used by development resolution, tests, and packaging.
- The daemon owns room observation, activation, FIFO delivery, retry,
  credential generation, and exactly-once publication.
- OpenCode receives one bounded turn at a time on its durable session and may
  use daemon-mediated LetAgents product tools.

## Authority and credential boundary

- Electron remains the encrypted durable custodian of the endpoint API key.
- Electron sends endpoint authority to the exact daemon generation over the
  owner-only control socket.
- The daemon retains that authority in memory only and passes it ephemerally
  into the exact provider spawn.
- OpenCode receives provider authentication through `OPENCODE_AUTH_CONTENT`.
  A runtime plugin removes provider and control credentials from model-created
  shell environments.
- The OpenCode control server binds only to loopback and uses a random Basic
  auth secret stored in an owner-only sidecar. The durable provider connection
  stores the sidecar path, never the provider API key.

## Lifecycle evidence

| Cell | OpenCode-backed Open Model |
| --- | --- |
| Dedicated native launch | One loopback `opencode serve` process per durable agent |
| Durable process identity | PID plus process birth/command identity |
| Observable terminal | Detached child exit plus exact-process observation |
| Continuation | Exact OpenCode session ID |
| Restart attach | Re-authenticate to the same verified server and session |
| Missing continuation | Same-process session repair through the provider-neutral repair contract |
| Bounded turn | `prompt_async` with a deterministic message ID; subscribe to `/event` first, then take one bounded transcript snapshot to repair the subscription race |
| Turn control | Native session abort |
| Room delivery | Daemon inbox only |
| Credential persistence | Electron encrypted settings only; never daemon SQLite, manifests, or room activity |

`attach()` uncertainty is deliberately not spawn authority. A missing or
temporarily unreadable local control sidecar may return an unknown result, but
only verified process death permits a replacement writer. This invariant keeps
restart recovery from creating two OpenCode processes for one durable agent.

## Live 1.18.9 contract evidence

Run:

```bash
cd apps/desktop
npm run smoke:opencode-contract
```

The smoke launches the pinned OpenCode binary against a loopback
OpenAI-compatible fixture and imports the same launch-contract and control
client modules as production. On 2026-07-29 it verified:

- the actual binary reports `1.18.9`;
- `prompt_async`, authenticated `/event`, exact message IDs, transcript reads,
  and `session.idle` complete one bounded turn;
- a model-issued shell command observes empty `OPENCODE_AUTH_CONTENT`,
  `OPENCODE_CONFIG_CONTENT`, `OPENCODE_SERVER_USERNAME`, and
  `OPENCODE_SERVER_PASSWORD` values;
- a fresh authenticated control client finds the exact existing session
  without a process relaunch;
- native session abort succeeds; and
- a distinct replacement session can be created on the same process.

This command is the load-bearing evidence behind the adapter’s `resume`,
`survivesRestart`, `native_interrupt`, and `same_process` capability claims.
Fake-fetch unit tests remain useful for failure ordering, but do not substitute
for this runtime contract.

## Removed legacy sessions

Codex-backed Open Model sessions are not compatible with this runtime and are
retired once at desktop startup. LetAgents disconnects their exact worker
sessions before deleting the old local session records, so they can no longer
observe or publish room work. Existing worktrees are preserved.

Those historical rows did not record a process-birth identity. LetAgents
therefore does not signal their saved PIDs: doing so could kill an unrelated
reused process. The retirement emits one structured diagnostic containing any
unverifiable PID, and users create a fresh OpenCode-backed Open Model agent.

## Regression anchors

- `apps/desktop/electron/__tests__/open-model-provider-adapter.test.ts`
  covers launch configuration, loopback authentication, credential isolation,
  one-snapshot event-driven bounded turns, exact-coordinate rejection, native
  abort, timeout, TERM-to-KILL stop, attach, and continuation repair.
- `apps/desktop/electron/scripts/opencode-runtime-contract-smoke.mjs` exercises
  the pinned binary and production credential-boundary plugin against a
  loopback model fixture.
- `apps/desktop/electron/__tests__/legacy-open-model-retirement.test.ts`
  proves old worker authority is disconnected before local compatibility rows
  are removed.
- `apps/desktop/electron/__tests__/open-model.test.ts` covers runtime preflight,
  pinned installation, settings validation, and product copy.
- `apps/desktop/daemon/__tests__/daemon.test.ts` covers exact-generation
  credential handoff and proves provider credentials do not enter durable
  daemon state.
- `apps/desktop/daemon/__tests__/provider-action-port-router.test.ts` covers
  OpenCode adapter selection and connection inference.
- `apps/desktop/electron/scripts/package-artifact.mjs` rejects a mismatched
  OpenCode version and includes the executable in the release artifact.
