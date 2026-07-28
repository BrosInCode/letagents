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
| Bounded turn | `prompt_async` with a deterministic message ID, followed through exact-session messages/status |
| Turn control | Native session abort |
| Room delivery | Daemon inbox only |
| Credential persistence | Electron encrypted settings only; never daemon SQLite, manifests, or room activity |

## Regression anchors

- `apps/desktop/electron/__tests__/open-model-provider-adapter.test.ts`
  covers launch configuration, loopback authentication, credential isolation,
  bounded turns, attach, terminal handling, and continuation repair.
- `apps/desktop/electron/__tests__/open-model.test.ts` covers runtime preflight,
  pinned installation, settings validation, and product copy.
- `apps/desktop/daemon/__tests__/daemon.test.ts` covers exact-generation
  credential handoff and proves provider credentials do not enter durable
  daemon state.
- `apps/desktop/daemon/__tests__/provider-action-port-router.test.ts` covers
  OpenCode adapter selection and connection inference.
- `apps/desktop/electron/scripts/package-artifact.mjs` rejects a mismatched
  OpenCode version and includes the executable in the release artifact.
