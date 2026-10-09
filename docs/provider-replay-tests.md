# Provider replay tests

A replay test runs a real provider adapter against a recording of the real
provider. The recording replaces only the transport. All of our own code runs.
A hand-written fake shows what we believe a provider sends. A recording shows
what it sent.

Code and recordings: `apps/desktop/electron/__tests__/provider-replay/`.
Tests: `codex-provider-replay.test.ts`, `provider-replay-harness.test.ts`.

## The transcript

`fixtures/<provider>/<scenario>.ndjson` holds one JSON entry on each line, in
the order the frames crossed the wire.

- `transcript_start`: provider, protocol, provider version, scenario, capture notes.
- `expect_outbound`: a frame LetAgents sent. The replay compares the adapter's frame with it.
- `emit_inbound`: a frame the provider sent. The replay gives it to the adapter.
- `runtime_exit`: the runtime ended. Exit code, signal, and which end closed first.

The loader rejects an unknown entry, an unknown key, and a malformed line.
The replay ignores recorded timing. A frame that differs from the recording
fails the test with a diff. A frame that never comes fails the test after a
guard time.
Do not write or edit a transcript by hand. If the adapter changed, record again.

One limit: the replay checks frame order for each direction, not across them.
It accepts an outbound frame that comes before inbound frames recorded ahead
of it. So it does not prove that the adapter waited for a reply. An adapter
that sends `thread/start` before the `mcpServerStatus/list` reply arrives
still passes. Assert such a dependency on what the adapter shows its caller.

## Record a Codex scenario

You need the Codex CLI, signed in. The recorder runs one real model turn.
It does not start the desktop app or the daemon. CI never runs it.

```sh
cd apps/desktop
LETAGENTS_RECORD_LIVE_CODEX=1 node --import tsx \
  electron/scripts/record-codex-replay.ts --scenario simple
```

1. Add the scenario in `provider-replay/codex-scenarios.ts`. The recorder and
   the test call the same function there. Use a trivial prompt.
2. Run the recorder. It works read-only in an empty temporary folder.
3. Read every distinct value in the new transcript before you commit it.
   Check its `redactions` counts.
4. Run the replay test. Assert what the adapter shows its caller.

Codex is real in a recording. The room's MCP server is a stand-in with no room.
Codex uses your own Codex home, so it adds one thread to your Codex history.

## Redaction

The recorder redacts every frame, then checks the result again. If the check
finds a leak, the recorder writes nothing. Redaction replaces values only.

Redaction is a first pass. It finds only the names and shapes it knows. Your
own read of every distinct value in a new transcript is the final control.

- Home folder, host names: `/home/replay-user`, `replay-host`.
- User name: `replay-user`, but only in a path, before `@`, or under a
  user-like key. A bare user name is not rewritten; the check reports it.
- Workspace, temp folder, repository: `<workspace>`, `<tmp>`, `<repo>`.
- Email addresses: `replay-user@example.com`. Tokens and keys: `<redacted>`.
- A credential written into text loses its whole value: `name=value` to the
  next space, a quoted value to its closing quote, an `Authorization` or
  `Cookie` header to the end of its line. The check fails on a value that is
  only partly redacted.
- A key that names a credential: everything under it is blanked.
- Ids (thread, turn, item, installation, account): one stable fake id each.
- Your own MCP server names, also in tool names: `owner-setup-name-N`.
- Account requests, replies and notifications: the keys stay, the values go.
- A string that is JSON is redacted as data, so the keys inside it count.

The Codex replay compares request ids, methods and parameters exactly, and the
order of the adapter's own frames. It does not compare the workspace path, or
the text of a `turn/start` input: that text is our prompt wording, not protocol.

## Add a provider

1. Find the lowest seam: the socket, the pipe, or the SDK call. Make only that
   seam injectable. Do not change behavior.
2. Write a transport for `ProviderReplaySession` (see `codex-replay.ts`), and a
   recorder that taps the same seam under the real adapter.
3. Reuse `redaction.ts`. Add rules for what the new provider reveals.
4. Record `simple` first. Then add one scenario for each real bug.
