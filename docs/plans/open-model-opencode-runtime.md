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
- The launch environment sets `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, so OpenCode
  does not list skills from `.claude/skills` or `.agents/skills` under the
  owner's home directory or the project. OpenCode's own `.opencode/skill(s)`
  directories, `skills.paths` from configuration, and its built-in skills still
  load.
- Every launch puts an empty `AGENTS.md` in the runtime's own OpenCode config
  directory. OpenCode adds one global instruction file to each system prompt:
  that `AGENTS.md` when it exists, otherwise the owner's `~/.claude/CLAUDE.md`.
  The empty file takes the place and adds nothing, so the owner's global
  `~/.claude/CLAUDE.md` does not reach the agent. A launch that cannot write
  the file fails. Reattaching to a running runtime writes it too, without
  failing, and OpenCode honours it from the next turn. Project instruction
  files still load, including a project's `CLAUDE.md` when it has no
  `AGENTS.md`; `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` would drop both and is
  not set. The contract smoke checks this and the skills setting against the
  pinned binary, from a planted home directory and Git project.
- A room's scratch workspace is launched with
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`. OpenCode looks for `AGENTS.md`,
  `CLAUDE.md`, `opencode.json` and `.opencode` directories from the working
  directory up to the root of its Git repository. A scratch workspace has no
  repository and lies under the owner's home, so without the setting an
  `AGENTS.md` in the home directory, or instructions named by an
  `opencode.json` there, reached the agent, and a `.opencode` directory on
  the way gave it an agent definition and had packages installed into it. A scratch workspace has no project files
  of its own to lose. Git worktrees are launched without the setting. A
  launch that does not say which kind of workspace it has is refused. The
  contract smoke checks both kinds.
- The setting does not stop plugins. OpenCode 1.18.20 has a second search
  with no switch. From a scratch workspace it still imports, inside the
  server process, which holds the provider key:
  - plugins in a `.opencode` directory anywhere between the workspace and
    the file system root;
  - plugins named by an `opencode.json` in one of those directories, and it
    fetches packages that file names.

  No launch setting bounds that search; `OPENCODE_PURE` also drops the
  credential-boundary plugin. A Git repository at the workspace, or at its
  parent `room-only` directory, does stop it. The workspace is deliberately
  not a repository, so that is a decision about the workspace, not about
  this launch. The contract smoke asserts the known state.
- `~/.opencode` is still read as an OpenCode config directory, for every
  workspace. Seen on 1.18.20: instruction files named in its `opencode.json`
  were loaded, a definition there of the primary agent, `build`, replaced
  that agent's prompt, and a skill there was listed. In the source, OpenCode
  also reads a system-wide managed configuration directory; that was not
  tested.

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

## Session status

OpenCode lists only sessions that are not idle, as `busy` or `retry`. `retry`
means it is waiting out a backoff before it re-sends a failed model request.
The adapter reads every listed session as an active turn. Reading `retry` as
a turn boundary made Stop a no-op during the backoff and let turn recovery
settle a turn as unreadable while OpenCode was still working on it.

How long a session stays in `retry` is not bounded by the adapter. OpenCode
1.18.20 retries five times. Without a `Retry-After` header the waits are 2,
4, 8, 16 and 32 seconds, each with up to 25% added, so 62 to 78 seconds in
total; one measured run took 69. With the header, the provider chooses each
wait. Only the turn timeout ends a long wait, and under `typed`
lifecycle authority there is no turn timeout. Stop is not delayed by the
backoff.

While a session waits to retry, the adapter says so. For each scheduled
retry it emits one stream event, `letagents/providerRetry`, whose summary is
"The model provider returned an error. Retrying (attempt N)." The chat work
indicator and the inspector show that sentence on the desktop that hosts the
agent. The provider's own message goes only into the event's payload, for
the inspector's diagnostics, with known credential formats redacted and
links removed.

The event is a `provider_event`, which the daemon reads as ordinary working
activity. It never changes a turn's outcome, a failure classification or a
schedule. Under typed lifecycle authority, which Open Model runs under, it is
recorded and nothing else. Under the other authority modes a stream event
also marks an idle agent as working, as any activity does. The agent
inspector's Live tab does not show it.

Two limits. A retry scheduled while the adapter is not observing the
session, such as just before a turn is recovered, is not announced until the
next one is scheduled. And retries inside a child session are not announced.

A turn stopped during a retry settles differently from one stopped while
busy. OpenCode reports an aborted busy turn as a failed message, so the turn
rejects with that failure. It reports an aborted retry with `session.idle`
only and an empty assistant message, so the turn resolves as unreadable. Both
results predate this fix. A turn stopped during a retry records no provider
failure, so the daemon settles it as cancelled by the user. A turn stopped
while busy can record its failure first, and the daemon then keeps that
failure. The daemon's side of this was read, not run.

## Launch budget

One 30 second budget covers a fresh launch: the health wait and the first
session share it. The first session bootstraps the OpenCode instance, so it
receives whatever the health wait left over instead of the 15 second
steady-state control deadline. A timeout names its phase (`health` or
`session`) and stays a transient start failure that the daemon may retry.

OpenCode installs its plugin SDK into any config directory that has no
`node_modules`, and a configured plugin makes the first session wait for that
install. Every runtime owns a fresh config directory, so the adapter seeds it
as already provisioned before launch. The credential-boundary plugin imports
nothing, so no package is needed. If the directory cannot be seeded the
launch proceeds on OpenCode's own install path.

The seed covers only the runtime's own config directory. OpenCode also
installs into every `.opencode` directory between the working directory and
the worktree root, and into `~/.opencode`, because the launch inherits `HOME`.
Those belong to the user and may hold tools that need the SDK, so they are
left alone. Each one that is not yet provisioned adds an install to the first
session: from a second to tens of seconds on a working network, depending
on the npm cache, and about 70 seconds when the registry
is unreachable, which exceeds the launch budget on every attempt.

`attach()` uncertainty is deliberately not spawn authority. A missing or
temporarily unreadable local control sidecar may return an unknown result, but
only verified process death permits a replacement writer. This invariant keeps
restart recovery from creating two OpenCode processes for one durable agent.

## Live 1.18.20 contract evidence

Run:

```bash
cd apps/desktop
npm run smoke:opencode-contract
```

The smoke launches the pinned OpenCode binary against a loopback
OpenAI-compatible fixture and imports the same launch-contract and control
client modules as production. It points npm at a loopback registry that
records every request. CI runs it in the `build` job, on Linux, whenever the
pin, the adapter's OpenCode modules, `provider-adapter.ts`, the electron
TypeScript configuration, the smoke, or the CI workflow change. A module the
smoke comes to import from anywhere else must be added to that list in
`ci.yml`. The desktop release workflow does not run it, so run it by hand on
macOS before changing the pin. On 2026-09-28 it verified:

- the actual binary reports `1.18.20`;
- the launch makes no npm registry request before its first session, and
  the seeded config directory stays empty of installed packages;
- `prompt_async`, authenticated `/event`, exact message IDs, transcript reads,
  and `session.idle` complete one bounded turn;
- a model-issued shell command observes empty `OPENCODE_AUTH_CONTENT`,
  `OPENCODE_CONFIG_CONTENT`, `OPENCODE_SERVER_USERNAME`, and
  `OPENCODE_SERVER_PASSWORD` values;
- a fresh authenticated control client finds the exact existing session
  without a process relaunch;
- native session abort succeeds;
- a distinct replacement session can be created on the same process;
- a complete answer with an unknown finish reason ends its turn after one
  model request; and
- a session waiting to re-send a failed model request reports `retry`, is
  read as an active turn, and ends on native abort.

## Choosing the pinned version

Change the pin only to a version that passes the contract smoke and is at
least seven days old, matching the dependency cooldown. CI enforces the
smoke; nothing enforces the age of the runtime, which is installed outside
the lockfiles.

1.18.20 is the newest version that passes. OpenCode 1.18.21 through at least
1.18.33 re-invoke the model without bound when a provider ends a complete
answer without a standard `finish_reason` (upstream issues 49414 and 45315,
both open on 2026-09-28). Any OpenAI-compatible endpoint can do that, so those
versions would turn one room turn into a request storm against the user's
provider account. The adapter's 32-step bound ends the turn only outside
`typed` lifecycle authority; under `typed` it raises attention instead.

Known cost of 1.18.20: from 1.18.17 OpenCode retries a provider error up to
five times when its message or body contains `429`, `500`, `502`, `503`,
`504` or `524` anywhere, including inside another number. A 402 that says the
account "can only afford 1500" tokens is retried for about 70 seconds before
the same error is reported. 1.18.9 reported it at once, but retried a 429
until the turn timed out, which 1.18.20 now bounds at six requests.

From 1.18.15 OpenCode ends a turn when the last assistant message answers the
last user message, instead of comparing message IDs as strings. The adapter
still mints user message IDs in OpenCode's ascending scheme.

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
