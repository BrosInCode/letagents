# OpenCode 2 runtime spike

Status: **findings only, no product change**

Open Model agents run on a supervised OpenCode server, pinned at 1.18.20. This
document records what moving to OpenCode 2 would involve. The current contract
is in [open-model-opencode-runtime.md](open-model-opencode-runtime.md).

Measured on 2026-09-28 on macOS against `@opencode/cli@2.0.11`, through
`opencode serve`, a loopback OpenAI-compatible provider and a loopback npm
registry. Every 2.0.11 figure below comes from
`apps/desktop/electron/scripts/opencode-v2-spike-probe.mjs`.

Figures for 1.18.20 were measured with throwaway scripts that are not in the
repository, using a minimal configuration rather than the production one.
The retry counts for 1.18.20 were also seen through the production adapter.

2.0.12 and earlier had cleared the seven-day dependency cooldown that day.
2.0.18 was the newest release; 2.x had published 19 releases in 14 days.

Re-checked on 2026-10-19 against 2.0.26. The results are in
[Re-check on 2.0.26](#re-check-on-2026-2026-10-19); the sections after it
describe 2.0.11 unless they say otherwise.

## Recommendation

Start the port behind a switch that is off by default. Keep shipping
1.18.20 until the port passes the contract smoke.

On 2.0.26 the two blockers about secrets have working solutions, measured
with the probe. Two items are still open upstream or unexplained:

- Keeping the owner's skills out of the model's prompt. 2.0.26 has no
  supported switch for it; see [Skills and instructions](#skills-and-instructions).
- The first turn after a server restart, in a session that already had
  turns, was not offered the MCP tools; see [MCP tools](#mcp-tools).

The rest is our own work: rewriting turn observation and its tests, and the
items in [What a port must do](#what-a-port-must-do).

1.x has no announced end of life, but upstream treats it as finished. On
about 2026-10-11 it closed the open 1.x issues in bulk and said development
is focused on 2.x. That included the unknown-finish issue
(anomalyco/opencode#49414), closed without a fix. 1.x still publishes small
releases (1.19.3 on 2026-10-16).

In September, on 2.0.11, the recommendation was not to migrate yet. It
named three reasons to revisit: an end of life for 1.x, slower 2.x
releases, or a need for something only 2.x has. 2.x releases slowed from
about 1.4 a day to about 5 a week (2.0.19 to 2.0.32 in 18 days). 2.x still
makes no stable-API promise.

## Re-check on 2.0.26 (2026-10-19)

Measured on macOS against `@opencode/cli@2.0.26`, the newest release past
the seven-day cooldown when the runs started. 2.0.32 was the newest
release. Same probe, with the switches added for this re-check. Every run
used a private HOME and private XDG directories, except the one run with
the inherited HOME named below.

### Blockers

| Blocker found on 2.0.11 | 2.0.26 | How |
| --- | --- | --- |
| The provider key would be stored and readable | Solved | Name the key's environment variable in the provider's `env` list |
| The credential-boundary plugin is rejected | Solved | A 2.x plugin blanks the secrets through `ctx.shell.hook("create.before")` |
| MCP tools reach the model differently, and late | Partly solved | 2.x MCP shape, then list the location's MCP servers and pause before the first turn after every start. Open: the first turn after a restart of a session with earlier turns |
| Turn observation and its tests are rewritten | Still true | The API contract in [What changes in the adapter](#what-changes-in-the-adapter) is unchanged where the probe used it. Interrupt and session status were not re-checked |

Found in this re-check, and not checked on 2.0.11:
`OPENCODE_DISABLE_EXTERNAL_SKILLS` has no effect, so the owner's skills
reach the model. See [Skills and instructions](#skills-and-instructions).

### The provider key

| How the key is supplied | Provider receives it | `GET /api/config` returns it | `GET /api/credential` returns it | Key in a file |
| --- | --- | --- | --- | --- |
| The key itself in the 1.x shape's `options.apiKey` | Yes | Yes | No | No |
| `"{env:NAME}"` in the 1.x `options.apiKey` or the 2.x `settings.apiKey` | Yes | Yes, resolved | No | No |
| `env: ["NAME"]` in the 2.x `providers` shape, no `apiKey` | Yes | No | No | No |
| `POST /api/integration/{id}/connect/key` | Yes | No | Yes | Yes, `opencode.db-wal` |
| `OPENCODE_AUTH_CONTENT` only | No | No | No | No |

"Key in a file" covers every file under the probe's temporary root: data,
state, cache, config, both HOMEs and the worktree. OpenCode's own folder
under `TMPDIR` was not scanned. Without the boundary below, a shell command
that prints the key also leaves it in `opencode.db-wal` and in a shell
output file under `data/opencode/shell/`.

With the `env` list, the key is still in the server's own environment. The
MCP server process inherits it, with the server password and
`OPENCODE_CONFIG_CONTENT`. 1.18.20 does the same: it starts MCP servers
with `{ ...process.env, ...mcp.environment }`.

### The shell environment

| Boundary | What a model-issued shell command printed | After a server restart |
| --- | --- | --- |
| None | The key and the server password | |
| `PUT /api/session/{id}/environment` | Empty values. The call replaces the whole environment: a variable left out of the body was gone too | Lost: the key and the password were printed again |
| A 2.x plugin with `ctx.shell.hook("create.before")` | Empty values | Still empty: the plugin loads at every start |

The hook received every inherited variable, secrets included: 16 in the
probe, 17 with `OPENCODE_TEST_HOME`. It set each secret to an empty string.
The plugin is a directory whose `index.js` exports `{ id, setup }` and
imports only Node built-ins. It is configured as
`plugins: [{ package: "<directory>", options: {...} }]`. Loading it made
0 registry requests.

Not tested: whether the hook also covers `POST /api/session/{id}/shell`
and terminal sessions.

### Retries

The same plugin can refuse a retry through `ctx.session.hook("retry")`,
by setting `event.decision = { retry: false }`. The hook sees the attempt
and the error type, so it can allow some retries and refuse others. It is
also asked about errors that 2.0.26 does not retry on its own, such as the
402 below, so a port's hook should refuse by default.

| Case | 2.0.26 as shipped | Plugin refuses every retry |
| --- | --- | --- |
| Answer without a finish reason | 11 requests over 84 seconds, then `provider.invalid-output`, 10 synthetic messages | 1 request in each of 6 runs, failed within 0.26 seconds |
| HTTP 429 on every request | 11 requests over 82 seconds, then `provider.rate-limit` | 1 request in each of 6 runs, failed within 0.26 seconds |
| HTTP 402 with `1500` in the message | 1 request, `provider.quota` with status 402 | 1 request |

The two "as shipped" rows are one run each, and match 2.0.11.

2.0.26 now sends `max_tokens` (8,192 in the probe). 2.0.11 sent no output
limit.

### MCP tools

- The 1.x shape still gives the model only `execute` (Code Mode).
- The 2.x shape, `mcp.servers.letagents` with `codemode: false`, gives the
  model the tool by name, `letagents_spike_echo`.
- A location's MCP servers start when a client first lists them
  (`GET /api/mcp?location[directory]=...`) or on the location's first
  turn. The turn that starts them is not offered the tools.
- After a list, the servers reported `connected` within 64 to 294
  milliseconds in every run. No signal was found for when the tools reach
  a session, so the probe pauses. A first turn started at once after
  `connected` had the tool in 0 of 5 runs; after 100 milliseconds in 4 of
  4, after 300 milliseconds in 8 of 8.
- A session whose first turn missed the tool was offered it on a turn 1
  second later. A turn started at once after the first also missed it.
- A session created before a restart worked after it, and a session with
  earlier turns kept them: the next model request carried them. The MCP
  servers start again only on the next list or turn. A new session's first
  turn after a restart had the tool when the probe listed the servers and
  paused 100 milliseconds or more.
- Not solved: in a session that already had turns, the first turn after a
  restart had no MCP tool, although the probe listed the servers and paused
  300 milliseconds, then 1 or 3 seconds. The turn after it had the tool.
  Seen in 2 runs.

### Skills and instructions

Measured with marked files planted in a private HOME and in the worktree.

| File | 2.0.26 | With `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` | With `OPENCODE_TEST_HOME` set to an empty directory |
| --- | --- | --- | --- |
| `~/.claude/CLAUDE.md` | Not read | Not read | Not read |
| `~/.claude/skills` | Listed | Listed | Not listed |
| `~/.agents/skills` | Listed | Listed | Not listed |
| `~/.opencode/skills` | Not listed | Not listed | Not listed |
| Project `CLAUDE.md` | Not read | Not read | Not read |
| Project `AGENTS.md` | Read | Read | Read |
| Project `.claude/skills` | Listed | Listed | Listed |
| Project `.agents/skills` | Listed | Listed | Listed |
| Project `.opencode/skills` | Listed | Listed | Listed |

In one run with the inherited HOME on the test machine, the model request
listed 18 of the owner's skills. The system prompt grew from 7,699 to
20,392 characters.

2.0.26 does not contain the string `OPENCODE_DISABLE_EXTERNAL_SKILLS`.
`OPENCODE_TEST_HOME` replaces OpenCode's own idea of the home directory,
which is where it looks for `~/.claude` and `~/.agents`. The shell keeps the
real HOME. Other effects of the variable were not measured. Its name says
it is for tests, so relying on it is fragile.

2.0.30 adds a `claude` setting: `claude: false`, or
`OPENCODE_DISABLE_CLAUDE_CODE`, drops every `.claude` folder from discovery
(anomalyco/opencode#55774). It leaves `.agents` folders. Not tested,
because 2.0.30 clears the cooldown only on 2026-10-22.

A plugin cannot remove these skills: `ctx.skill.transform` lists only the
two built-in skills.

### Other results

- Basic authentication with `OPENCODE_SERVER_PASSWORD` still protects
  `/api/*`. Without credentials, `GET` on `/api/info`, `/api/config`,
  `/api/session/active` and `/api/event` returns 401; a wrong password does
  too.
- A `GET` on any other path returns 200 and the web interface's HTML, with
  or without credentials, including the 1.x paths. `POST /session` returns
  405.
- Local authentication for the 2.x service API is still not documented
  (anomalyco/opencode#51724 is open). The documentation describes
  `opencode pair` and `Service.headers`, not Basic authentication.
- The server subscribes to the entries of every folder above the working
  directory, up to `/`. In the run with the inherited HOME it also
  subscribed to the entries of HOME and to `~/.claude/skills`. With private
  XDG directories it wrote nothing to the owner's OpenCode folders.
- `GET /api/session/{id}/environment` returns 404, so the replaced
  environment cannot be read back.
- Still as on 2.0.11: `OPENCODE_AUTH_CONTENT` is ignored, the 1.x
  single-file plugin is rejected with "configured plugin path must be a
  directory", the 1.x provider shape loses the same five settings, and the
  permission reply with `decision: "once"` works.

### Not measured on 2.0.27 to 2.0.32

Changes upstream that touch this document, from the tag comparison:
`claude: false` (above, 2.0.30), continuing answers after an output limit
(#53876), "align connect route checks" (#55177), `credential.activate` for
server plugins (#52797) and plugins asserting permissions (#54930). Re-run
the probe on the version we pin.

### What a port must do

1. Port `apps/desktop/electron/scripts/opencode-runtime-contract-smoke.mjs`
   (`npm run smoke:opencode-contract` in `apps/desktop`) to 2.x first, and
   pin an exact 2.x version that has cleared the cooldown.
2. Supply the provider key through the provider's `env` list in the 2.x
   `providers` shape.
3. Replace the 1.x plugin with a 2.x plugin that blanks the secrets in
   `ctx.shell.hook("create.before")` and decides retries in
   `ctx.session.hook("retry")`, refusing by default.
4. Configure the `letagents` MCP server in the 2.x shape with
   `codemode: false`. After every server start, list the location's MCP
   servers, wait for `connected`, and pause before the first turn. No
   signal for the tools reaching a session was found; 100 milliseconds
   was enough in the probe.
5. Find out why the first turn after a restart, in a session with earlier
   turns, has no MCP tools, and fix or work around it.
6. Keep the owner's skills out: a private HOME, or `claude: false` (2.0.30
   and later) plus a way to hide `~/.agents/skills`.
7. Rewrite turn observation, the transcript reader and their tests for the
   2.x events and records.

## Two findings about the runtime we ship

Both come from the launch inheriting `HOME`. On 1.18.20 the owner's
`~/.claude` and `~/.agents` skills and the owner's `~/.claude/CLAUDE.md` no
longer reach the agent. Other files of the owner's still do. The current
behaviour, and what is left, is in
[open-model-opencode-runtime.md](open-model-opencode-runtime.md).

### The owner's skills were offered to the agent

Measured before the fix, without the setting that is now in place.

| Runtime | `HOME` | System prompt | Skills listed |
| --- | --- | --- | --- |
| 1.18.20 | inherited | 23,373 characters | 19 |
| 1.18.20 | private and empty | 9,592 characters | 1, built in |
| 2.0.11 | inherited | 23,866 characters | 20 |
| 2.0.11 | private and empty | 11,980 characters | 2, both built in |

On the test machine, 18 of the 19 came from under `~/.claude/skills`: five
installed by hand and 13 synced there by another tool. What was measured is
that the model's system prompt lists them and that the model is offered the
`skill` tool to load one. Whether a model acts on them was not tested.

Every model request also carried the extra text to the user's provider:
about 14,000 characters on 1.18.20 and 12,000 on 2.0.11.

The 1.18.20 private-`HOME` row was measured during the review of this
document. Whether `git` and `gh` still work under a private `HOME` was not
tested on either version.

Fixed by setting `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` at launch, which keeps
the inherited `HOME`. It is in the first desktop release after 0.1.98. On
1.18.20 it took a 23,326-character prompt with 19 skills to 9,592 characters
and 1 skill. It also stops a project's `.claude/skills` and `.agents/skills`
from being listed. Skills in `.opencode` directories still are: the
project's, and the owner's under `~/.opencode`.

### The owner's `~/.claude/CLAUDE.md` was given to the agent as instructions

Found while reviewing the skills fix, on 1.18.20, with marker text planted
in the file and the model request captured. The test machine has no such
file, so the prompt lengths above never showed it.

OpenCode 1.18.20 reads one global instruction file: `AGENTS.md` in its own
config directory when that exists, otherwise `~/.claude/CLAUDE.md`. The fix
is an empty `AGENTS.md` in the runtime's private config directory.
`OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1` also hides the owner's file, but it
stops a project's `CLAUDE.md` from being used as well.

2.0.11 does not read the file. With markers planted, neither
`~/.claude/CLAUDE.md` nor a project's `CLAUDE.md` reached the model request;
`AGENTS.md` files did. So a project that has only a `CLAUDE.md` would lose
its instructions on 2.x.

## What OpenCode 2 does better

| Case | 1.18.20 | 2.0.11 |
| --- | --- | --- |
| HTTP 402 whose message contains `1500` | Retried: 6 requests, about 70 seconds | Not retried: 1 request, failed within 0.1 seconds |
| What a retry or failure event carries | Attempt, message and next retry time | Also an error type and the HTTP status, for example `provider.quota` and `402` |
| Fresh runtime | Installs a 61 MB plugin SDK unless its config directory is seeded | No install: 0 registry requests, empty config directory, no seeding |
| Keeping secrets out of the model's shell | Needs a plugin | `PUT /api/session/{id}/environment` replaces the shell's environment. On 2.0.26 that is lost at a restart, so a 2.x plugin is still needed; see [The shell environment](#the-shell-environment) |

On 1.18.20 the HTTP status does reach us, but only in the final error after
the retries are spent.

## What OpenCode 2 does worse

| Case | 1.18.20 | 2.0.11 |
| --- | --- | --- |
| Complete answer without a finish reason | Accepted after 1 request | Treated as a failure and retried: 11 requests over 78 seconds, then the turn fails |
| HTTP 429 on every request | 6 requests over about 70 seconds, then fails | 11 requests over 86 seconds, then fails |
| Output limit | Sends `max_tokens` | Sends no output limit, so our 8,192 cap is not applied |

Each retry of an answer without a finish reason adds a synthetic message to
the transcript, "The previous response was interrupted. Continue from where
you left off without repeating completed content."

On 2.0.26 the retry counts are the same, but a 2.x plugin can refuse
retries, and the output limit is sent. See [Retries](#retries).

## What blocks a migration

Measured on 2.0.11. On 2.0.26 the first two blockers are solved; see
[Blockers](#blockers).

### The provider key would be stored and readable

Our contract is that the provider key lives only in Electron's encrypted
settings and is handed to the runtime in memory.

1.18.20 reads the key from the `OPENCODE_AUTH_CONTENT` environment variable.
2.0.11 ignores that variable: with the key supplied only there, the provider
received no `Authorization` header. 2.0.11 offers two ways to supply a key,
and neither meets the contract.

| Method | Works | Problem |
| --- | --- | --- |
| Key in the provider's `options`, inside `OPENCODE_CONFIG_CONTENT` | Yes | `GET /api/config` returns the key to any authenticated caller |
| `POST /api/integration/{id}/connect/key` | Yes, once the location's integrations have been listed | The key is written, unencrypted, to OpenCode's database under the data directory |

### The credential-boundary plugin is rejected

The 1.x plugin is a single file. 2.0.11 logs "configured plugin path must be
a directory" and lists no plugin. With the plugin configured, a model-issued
shell command printed the provider key and the server password.

Replacing the session environment fixed that in the probe: the same command
printed empty values. 2.x also has its own plugin hook for the shell
environment, which the probe did not try on 2.0.11.

Not tested on 2.0.11: whether the replaced environment survives a server
restart, and whether it reaches MCP server processes. On 2.0.26 it does not
survive a restart, the 2.x plugin hook works, and MCP server processes
inherit the server's environment; see
[The shell environment](#the-shell-environment).

A shell's output is stored in the transcript, so a leaked key also ends up
in OpenCode's database.

### MCP tools reach the model differently, and late

The `letagents` MCP server is how a room agent replies. 2.x has two ways to
hand an MCP server's tools to the model. In Code Mode, the default, the model
gets one tool, `execute`, which runs code that calls the MCP tools. With
Code Mode off for a server, its tools are listed beside OpenCode's own.

| MCP configuration | What the model is offered |
| --- | --- |
| 1.x shape, as the adapter writes it today | `execute` only; the MCP tool is named in the request's text for `execute` to call |
| 2.x shape with `codemode: false` | The tool by name, as `letagents_spike_echo` |

The 1.x shape has no way to turn Code Mode off. So a migration must rewrite
the MCP configuration. The tool keeps the name 1.18.20 gives it.

In both shapes the tools reach a session after the server reports itself
connected, not with it. The server connected within 0.1 seconds. A turn
started at once was offered no MCP tool in either shape; a turn started 0.3
seconds later was. The adapter would have to wait for the tools, not for the
connection, before the first room turn.

Not tested: whether a weaker open model can call tools through `execute`.

## What changes in the adapter

| Part of the contract | 1.18.20 | 2.0.11 |
| --- | --- | --- |
| Health | `GET /global/health` | `GET /api/info`, returning `version`, `pid`, `urls`, `paths` |
| Authentication | Basic, `OPENCODE_SERVER_PASSWORD` | Same. Missing or wrong credentials return 401 |
| Configuration | `OPENCODE_CONFIG_CONTENT` | Same variable, 1.x shape accepted, five settings dropped |
| Create session | `POST /session` with `title` | `POST /api/session` with `title` and `location.directory` |
| Start a turn | `POST /session/{id}/prompt_async` with `messageID` and `parts` | `POST /api/session/{id}/prompt` with `text` and optional `id` |
| Stop a turn | `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt`, returning `interrupted` |
| Session status | `GET /session/status`: `busy` or `retry` | `GET /api/session/active`: `running` |
| Events | `GET /event` | `GET /api/event`, with a different event set |
| Turn end | `session.idle` | `session.execution.succeeded`, `failed` or `interrupted` |
| Transcript | Messages with `info` and `parts` | Flat typed records, including `user`, `assistant`, `synthetic` and `idle` |
| Permission reply | `POST /permission/{id}/reply` with `reply` | `POST /api/session/{id}/permission/{id}/reply` with `decision` |
| Shell tool name | `bash` | `shell` |

Both versions accept a user message ID supplied by the caller.

The five dropped settings are the provider's `id` and each model's
`attachment`, `reasoning`, `temperature` and `release_date`.

The tool list changes too. 2.0.11 offers `shell`, `subagent`, `websearch`
and `execute`; 1.18.20 offers `bash`, `task` and `todowrite`. The adapter
recognises the shell tool by the name `bash`.

2.x scopes pending permission requests, MCP servers and integrations to a
location, which is a working directory. A request that names no location
describes the server's own working directory. One that names the session's
must use the resolved path, without symbolic links, or it describes a
different place and the lists come back empty.

### A 2.x server answers 1.x paths

With valid credentials, every `GET` to a path 2.0.11 does not know returns
200 and the web interface's HTML, including `/global/health`. A `POST` to
`/session` returns 405.

The adapter's launch check accepts any 200, so it would pass against a 2.x
server. Its control probe requires a JSON body and would report an invalid
response.

## Measurements

The probe polls every 25 milliseconds, so each duration is an upper bound.

| Scenario | Model requests | Result |
| --- | --- | --- |
| Plain answer | 1 | Succeeded within 0.1 seconds |
| One shell tool call | 2 | Succeeded within 0.14 seconds |
| Shell tool, permission asked, replied `once` | 2 | Succeeded within 0.15 seconds |
| HTTP 402 with `1500` in the message | 1 | Failed within 0.1 seconds, `provider.quota` |
| HTTP 429, first 9 seconds | 3, at 0.06, 2.0 and 5.6 seconds | Still running; interrupt accepted |
| Answer without a finish reason, first 9 seconds | 3, at 0.06, 1.9 and 5.9 seconds | Still running; interrupt accepted |
| HTTP 429, left to finish | 11 | Failed after 86 seconds, `provider.rate-limit` |
| Answer without a finish reason, left to finish | 11 | Failed after 78 seconds, `provider.invalid-output`, 10 synthetic messages |

Across 23 runs the server answered `GET /api/info` between 0.11 and 0.31
seconds after launch, with a median of 0.12. In the 22 that created a
session, it took 4 to 11 milliseconds.

## Not tested

Updated on 2026-10-19. Sessions across a server restart, a plugin written
for 2.x, and 2.0.26 are now tested; see
[Re-check on 2.0.26](#re-check-on-2026-2026-10-19).

- Reattaching to a running server after a desktop or daemon restart.
- Session repair.
- Interrupting a turn and reading session status on 2.0.26.
- `typed` lifecycle authority, under which the adapter reports turn outcomes
  only from what the runtime itself declares.
- The other tools 2.x offers by default, including a browser and network
  access from inside `execute`.
- Whether a weaker open model calls MCP tools through `execute`.
- Whether the shell hook covers `POST /api/session/{id}/shell` and terminal
  sessions.
- A way to hide `~/.agents/skills` other than `OPENCODE_TEST_HOME` or a
  private HOME.
- Linux and Windows.
- Releases after 2.0.26.
- Any real model provider.

## Rerunning the probe

```bash
npm install --global --prefix /tmp/opencode-v2 @opencode/cli@2.0.11
node apps/desktop/electron/scripts/opencode-v2-spike-probe.mjs /tmp/opencode-v2/bin/opencode plain
```

The 2.0.26 re-check installed with `--ignore-scripts` and ran the platform
binary directly, because the package's install script only copies that
binary into place:

```bash
npm install --global --ignore-scripts --prefix /tmp/opencode-v2 @opencode/cli@2.0.26
```

The binary is then at
`/tmp/opencode-v2/lib/node_modules/@opencode/cli/node_modules/@opencode/cli-darwin-arm64/bin/opencode`.

Run each scenario with the configuration a port would use.
`SPIKE_PLUGIN_NO_RETRY` refuses every retry, which a port would decide
per error:

```bash
SPIKE_PRIVATE_HOME=1 SPIKE_KEY_REF=env SPIKE_PLUGIN=native SPIKE_PLUGIN_NO_RETRY=1 \
SPIKE_MCP=native SPIKE_MCP_WARM=1 SPIKE_SETTLE_MS=300 SPIKE_RESTART=1 \
  node apps/desktop/electron/scripts/opencode-v2-spike-probe.mjs <binary> tool
```

The scenarios and switches are listed at the top of the probe. It prints one
JSON report. It stops the server it starts and removes its temporary
directory, including when it fails or receives a termination signal.
