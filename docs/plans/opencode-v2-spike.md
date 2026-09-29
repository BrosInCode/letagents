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

## Recommendation

Do not migrate yet.

OpenCode 2 handles provider errors better than 1.18.20 and needs no install
workaround. Against that, it handles retries and incomplete answers worse,
it would put the provider key in places our contract forbids, and the
adapter's turn observation and its test harness would be rewritten.

Revisit when one of these is true:

- OpenCode announces an end of life for 1.x.
- 2.x releases slow from near-daily to about weekly, and its HTTP API stops
  describing itself as experimental.
- We need something only 2.x has. Provider errors that carry their HTTP
  status are the strongest candidate.

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
| Keeping secrets out of the model's shell | Needs a plugin | `PUT /api/session/{id}/environment` replaces the shell's environment |

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

## What blocks a migration

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
environment, which the probe did not try.

Not tested: whether the replaced environment survives a server restart, and
whether it reaches MCP server processes. A shell's output is stored in the
transcript, so a leaked key also ends up in OpenCode's database.

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

- Reattaching to a running server after a desktop or daemon restart.
- Session repair, and whether sessions survive a server restart.
- `typed` lifecycle authority, under which the adapter reports turn outcomes
  only from what the runtime itself declares.
- A plugin written for 2.x, and whether configuring one triggers an install.
- The other tools 2.0.11 offers by default, including a browser and network
  access from inside `execute`.
- Linux and Windows.
- Releases after 2.0.11.
- Any real model provider.

## Rerunning the probe

```bash
npm install --global --prefix /tmp/opencode-v2 @opencode/cli@2.0.11
node apps/desktop/electron/scripts/opencode-v2-spike-probe.mjs /tmp/opencode-v2/bin/opencode plain
```

The scenarios and switches are listed at the top of the probe. It prints one
JSON report. It stops the server it starts and removes its temporary
directory, including when it fails or receives a termination signal.
