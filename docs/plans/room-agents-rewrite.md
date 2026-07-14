# Room Agents Rewrite — Canonical Plan

- **Version:** v9 (supersedes v8; ratifies the grant-gated HTTP rebind route, adds the both-sessions-bound-to-grant rule + the terminal-attestation contract, and sequences P1.5 after P1b per the #761 review)
- **Status:** v6, v7, and v8 approved and merged to staging (PRs #753/#754/#756). Each revision becomes authoritative only when merged. **Author (PeakCloud) is excluded from this document's review gate.** Plan gate reviewers: RiverRiver (architecture) + RiverSilver (independent evidence check); EmmyMay morning ratification recorded in the decision log as override authority.
- **Authority:** once merged, this document is the single normative source. Board tasks are cut from it verbatim; chat messages never amend it — revisions are PRs to this file.
- **Decision log:** EmmyMay 2026-07-14: rewrite from scratch, no patches; lightweight model implements; PeakCloud + RiverRiver hold final merge say on **implementation PRs** (author always excluded from any gate they authored — for THIS document the gate is RiverRiver + RiverSilver, PeakCloud counts zero). Defaults pending EmmyMay override: cloud-backed rooms only in v1; brokered external writes; supervisor daemon in phase 1.

## 1. Evidence

Three desktop-managed reviewers died in one night (2026-07-14, focus_34), each to a distinct structural flaw of the event-turn model:

1. **StoneRiver** (codex): the 60-minute unpausable turn ceiling killed it mid-review. A half-formed `"sdf"` `CHANGES_REQUESTED` escaped to PR #750 and hard-blocked the pipeline. The status reconciler then overwrote the kill reason (`last_error: null`).
2. **BrightHarbor** (codex): dead 33 seconds after being added, during its acknowledgement turn, amid dev restarts of the host app. `process.on("exit")` kills every spawned agent process in every room.
3. **SummitFern** (claude): its review turn was preempted by a *liveness status message* (`shouldPreemptOnEnqueue: () => true`, claude-code-runtime.ts). The preempted event was never re-delivered; the review evaporated while the session stayed "alive".

Every pull-based MCP worker survived the same night doing heavier work. The push model's wrong axioms: events are pushed at agents (forcing an unanswerable preempt-vs-queue choice), the turn is the unit of existence (work has no durable identity), and the GUI process is the host (agent lifetime coupled to an app restarted constantly during development).

## 2. Thesis

An agent is a **durable intent** ("X reviews in room Y"), realized by a **disposable headless process**, supervised to convergence. Room agents are pull-based MCP workers (`register_agent_session` → `wait_for_messages` → work → `send_message`). The desktop app stops being the runtime and becomes **control plane + viewport + local resource broker**.

## 3. Auth principals (foundation — first coding work)

Verified 2026-07-14: the MCP runtime authenticates with the **owner bearer** (`getAuthorizationHeader`, src/mcp/server/runtime.ts); agent sessions mint a per-session `session_token` (hashed, `LETAGENTS_AGENT_SESSION_TOKEN_HEADER`) but it rides alongside owner auth, never instead of it. A spawned child today would inherit the owner token. **No live child may receive an owner token.** Three principals:

| Principal | Held by | Scope | Storage |
|---|---|---|---|
| **Owner bearer** | Human's authenticated apps only | Everything | Existing saved auth |
| **Supervisor host grant** | The daemon | Allowed rooms + agent identities; session lifecycle (mint/rotate/end worker sessions); fenced lease rebind. Nothing else — no owner routes. | OS credential store (Keychain); bound to host_id/installation. **Durable across daemon restarts** — the supervisor generation is NOT part of the credential; it is a fencing proof presented per operation and validated server-side as current for that host |
| **Worker bearer** | Each spawned agent process | `authKind=agent_session`: one room, one session, capability set, expiry, revocation, generation | Process env from daemon; never written to disk by the child |

Requirements:
- Server: accept `authKind=agent_session` bearers (extend existing session_token primitive); scope checks on every route; revocation + expiry + stale-generation rejection; redaction in logs.
- MCP runtime: a mode that uses a provided worker bearer and **never loads saved owner auth**.
- Supervisor grant: owner provisions it explicitly (UI flow); revocable server-side. The grant is itself **short-lived and renewable**: bounded validity window, rotated on daemon heartbeat renewal; a daemon that stops renewing (offline uninstall, sign-out, revocation) loses the grant at window end and every worker bearer minted under it expires with its own shorter TTL. Exposure bound after offline uninstall = max(worker-bearer TTL, remaining grant window) — both short, both server-enforced; local credential deletion is best-effort on top, never the safety argument.
- Credential isolation is **environmental, not just policy**: each spawned child runs with an isolated HOME/state directory containing exactly two credential classes and nothing else: (1) a **minimal provider credential projection** — the daemon copies only the provider's own auth material (e.g. Claude session credentials) into the isolated HOME, since the runtime cannot function without it; (2) the worker bearer via env. No inherited `~/.config/gh`, no git credential helpers, no other provider auth. Git pushes to the attempt branch are **brokered, not credentialed**: standard git credential helpers cannot see or enforce the pushed ref, so the child holds NO repo-write credential of any kind. Instead the child invokes `push_attempt_branch` (daemon control-socket op): the daemon validates `{repo, work_attempt_id, ref == the attempt branch, expected old SHA}` and performs the push itself with force-with-lease semantics from the attempt workspace. Push capability is therefore a validated operation, not a token, and dies with the attempt. All other task-linked GitHub writes are broker-held server-side. Permission profiles are defense-in-depth on top, never the primary barrier.
- **Launch-isolation envelope (P0-safe finding, canonical):** an isolated HOME alone is INSUFFICIENT — provider runtimes also load workspace/project-level configuration (proven: a fresh-HOME `claude mcp list` still discovered project MCP config from the cwd). Supervised launches MUST suppress workspace/project/local MCP servers, settings, hooks, plugins, and instruction files under an explicit, empirically **proven** envelope (for Claude: curated `--mcp-config` + `--strict-mcp-config` + restricted `--setting-sources`/`--settings`; per-provider equivalents proven per adapter). Requirements: (1) P0-safe proves suppression of every **pre-auth-resolvable** vector against a synthetic malicious workspace **without executing any untrusted hook** (inventory loading, not effects, e.g. via the `--debug`/`--debug-file` config-resolution log); any vector whose loading occurs only after the runtime auth gate is a named **bounded negative** that becomes a **P0-live hard gate** — for this plan the sole such deferred vector is instruction memory (`CLAUDE.md`); (2) P0-live empirically discovers the minimal provider-auth projection (never guessed — an unproven projection is recorded as a bounded negative result) and re-proves the envelope with a live child; (3) the provider adapter (P1c) hard-depends on both proofs and may not guess credentials or configuration — its test suite must assert a child in a malicious workspace sees only daemon-provided configuration.
- **P0-safe proof status (task_22, claude 2.1.70, non-executing debug-resolution inventory):** four of five vectors are POSITIVELY PROVEN suppressed under the envelope `--mcp-config <daemon> --strict-mcp-config --setting-sources user` in a curated HOME: (i) **MCP servers** — malicious project `.mcp.json` discovered at baseline, absent under the envelope; (ii) **settings** — project/local settings never entered the resolution set (baseline referenced the project dir and loaded its settings, envelope referenced it zero times); (iii) **hooks** — baseline matched the malicious `SessionStart` hook, envelope reported `Found 0 hook matchers`; (iv) **plugins** — under the envelope with NO `--plugin-dir`, `0 plugins` load: the fixture workspace plugin was not auto-discovered under restricted setting sources and the curated HOME contained no user plugins (evidence is scoped to that configuration; `--plugin-dir` is additive and unnecessary here — dropped from the recommended argv). Two load-bearing caveats confirmed: **`--strict-mcp-config` is a NO-OP unless paired with `--mcp-config`**, and `--mcp-config` is a variadic global flag that must precede any subcommand — the adapter must construct argv accordingly. (v) **Instruction memory (`CLAUDE.md`)** could NOT be proven unauthenticated (it loads after config resolution, past the point the auth wall halts an unauthenticated session) — it remains a **P0-live hard gate**. P0-live must prove, live, whether a workspace `CLAUDE.md` is ingested under the envelope in BOTH launch shapes — (α) workspace-as-cwd and (β) neutral-cwd + `--add-dir <workspace>` — since `--setting-sources` governs settings, not instruction memory. **Outcome-safe rule:** if neither shape suppresses `CLAUDE.md`, P1c stays BLOCKED and the architecture must change to a sanitized workspace projection / brokered file surface (the agent sees a curated view, not the raw untrusted tree); shipping by omitting the test or silently choosing the less-observable launch is prohibited. **P1c may not freeze its spawn argv until P0-live resolves vector (v) under this rule.**
- Tests: cross-room access rejected; owner-only routes rejected; ended-session bearer rejected; **replay** (a bearer presented after its rotation, revocation, or generation supersession — bearers are not sender-constrained in v1, so post-invalidation rejection is the enforced property) rejected; expired bearer rejected; stale-generation rejected; tokens redacted from logs and error bodies.

## 4. Architecture

### 4.1 Supervisor daemon (phase 1)
Standalone Node process (no Electron imports), spawned detached and observed by Electron but surviving its exit — the reconciler must not live in the UI failure domain. Singleton flock + monotonic supervisor generation; manifest and rebind writes CAS on generation. Control surface: unix socket, JSON-lines, versioned protocol (mismatch = explicit failure; upgrades do a negotiated generation-bump handoff that never blind-kills workers). **Platform scope v1: macOS only** — visibly capability-gated elsewhere; Windows parity is a tracked follow-up task.

### 4.2 Desired-state model (three axes)
- Manifest `desired_state`: `running | paused | stopped`
- Observed execution: `absent | starting | idle | working | checkpointing | pausing | paused | recovering | stopping | stopped | failed`
- Policy condition: `none | quarantined | coordination_blocked | auth_blocked | budget_blocked | security_blocked` (`coordination_blocked` = recovery is held by lease/rebind state, e.g. the pre-rebind rule in §4.4; enters from `recovering`, exits on rebind success, lease release/expiry, or human direction)

Manifest entries: `{id, room_id, display_name, provider, model, charter, desired_state, permission_profile_id, created_by, created_at}`. Manifest writes are crash-consistent (temp file + fsync + atomic rename + checksum; checksum validated before load). Deletion = GC of a stopped entry, never the representation of a kill. Every transition appends `{at, from, to, cause, actor, generation}` to an audit log that is archived/rotated when it reaches its bound — never truncated in place. UI shows all three axes honestly (e.g. desired=running, observed=stopped, blocked_by=crash_loop).

### 4.3 Work durability (two record types)
- **`task_work_attempt`** — owns the workspace; identified by an **immutable `work_attempt_id`** minted at creation (lease epochs change on rebind, so they cannot be the key — the record tracks `{task_id, lease_id, current_lease_epoch, epoch_history[]}` separately). Survives process death AND rebind; ends only when work concludes or is abandoned with explicit cause. Workspace: `~/.letagents/worktrees/<repo>/<work_attempt_id>`, provisioned from a daemon-owned clone (`~/.letagents/repos/<repo>.git`), **never the user's dev checkout**, and **reused across process restarts and rebinds** — a restart lands in the same tree with uncommitted work intact.
- **`execution_generation`** — one per process run; disposable; carries the immutable terminal payload `{ended_at, exit_code, signal, bounded stdio tail, terminal_cause, actor, generation, provider_continuation_id}`. Append-only; the `last_error`-laundering class becomes structurally impossible.
- Checkpoints (room cursor, provider continuation id) written at every poll boundary. Durability is **supervisor-owned**, not prompt-dependent: the daemon captures state at lifecycle and observed tool boundaries (transcript tail) regardless of agent cooperation; the findings scratchpad (append-only draft artifact per work attempt) is the agent-facing layer on top. Logs and stdio are append-only and archived/rotated — never truncated in place; terminal payloads reference the archive.
- GC never deletes workspaces of active, ambiguous, quarantined, or unreviewed work; keep-N applies only to cleanly concluded work attempts. Post-mortem diff captured at attempt end.

### 4.4 Graduated attention (replaces all turn-killing)
1. **Wait** — messages queue server-side; slow ≠ dead.
2. **Poke** — inject a message into the running session at the next tool boundary (capability-gated per provider).
3. **Restart-with-resume** — rejoin preamble: re-read cursor, lease, board, findings scratchpad, unconfirmed effects. **Config-gated OFF until fenced rebind (§4.5) is merged and proven.** Pre-rebind rule: restart is allowed only when the agent holds **no active task/review lease**; otherwise observed stays `recovering` with condition `coordination_blocked`, workspace and attempt state preserved, and a human/inbox escalation — a rejoin prompt cannot cross an authorization boundary.
4. **Terminal** — quarantine + death record + inbox card.

Watchdog predicate: `no poll ≥ threshold ∧ addressed messages waiting ∧ poke ignored`. Never fires on turn duration alone. Crash-loop: ≥5 exits in 10 min → quarantined, restarts stop. Lifecycle telemetry goes to status/reasoning lanes; only quarantine/death get one honest room `[status]` message + inbox card.

### 4.5 Fenced lease rebind (server)
Leases bind to `agent_session_id`; a restarted process registers a new session, so resume requires a server-side rebind — a prompt cannot fix authorization. Semantics: CAS on lease id + lease epoch; same `agent_key` necessary but not sufficient — the rebind must be authorized by the fenced supervisor identity (host_id + supervisor generation validated); old attempt terminal or explicitly revoked; old session's delivery authority revoked in the same transaction; **epoch checked on every lease-guarded write path**, so a partitioned-but-live old worker's writes are rejected after rebind. Tests include malicious same-agent-key registration from another host and the partitioned-live-old-worker case.

**Control surface (ratified):** rebind is exposed as a **grant-gated HTTP route** (`POST /supervisor-host-grants/:grantId/leases/:leaseId/rebind`), NOT an MCP tool. This follows the F3 precedent — supervisor-authority operations are HTTP routes the daemon calls with its grant bearer; the daemon is not an MCP worker. The route is default-deny in the supervisor-grant route registry. (Supersedes the "MCP tool" wording in the task_13 board text.)

**Both sessions bound to the grant:** both the predecessor (`from`) and successor (`to`) session must be `session_kind==='worker'`, owned by the grant's owner, and carry `supervisor_grant_id === grant.grant_id` — so a grant for host A cannot seize a same-agent-key lease whose predecessor belongs to host B.

**Terminal attestation (required for final P1.5 approval):** generic `session.ended_at` is *auth* terminality, not *process/work* terminality — an ended session can still leave a live OS process writing the reused workspace (two-writers hazard). The complete rebind therefore consumes a **server-persisted terminal/revocation attestation record** — not an opaque flag — with the exact tuple `{lease_id, epoch, from_session, work_attempt_id, execution_generation_id, supervisor_generation}` plus a `cause` and `attested_at` timestamp, written by the authoring supervisor generation and **consumed exactly once** inside the rebind transaction (a used attestation cannot be replayed). It reads P1b's `execution_generation` terminal state. The interim `from`-session-ended predicate is **not sufficient and is not a shippable final state**: final P1.5 approval is gated on the attestation, and no known-residual rebind merges.

**Safe restart order (normative — P1d executes this, P1.5 enforces it):** (1) kill the old worker OS process and **wait** for confirmed exit; (2) record the immutable `execution_generation` terminal payload and take the exclusive single-writer workspace fence; (3) mint the successor auth session **without** spawning its child yet; (4) consume the terminal attestation and commit the fenced rebind (epoch+1) in one transaction; (5) only then spawn the successor under the rebound bearer, **retaining** the workspace fence across the handoff. No step may spawn the successor process before the rebind commits.

**Sequencing (linear, no cycle):** **P1b (task_15) → P1.5 (this server fence + attestation) → P1d (runtime consumer)**. P1.5 defines and persists the attestation and enforces the epoch fence; **P1d is the consumer** — it produces the attestation by kill-confirming the predecessor OS process and holding a single-writer workspace fence before spawning the successor, then presents it to the rebind. P1.5 depends on P1b's attempt model, not on P1d. The mandatory epoch sweep across *every* lease-authorized `agent_session` write surface (task mutations, artifact writes, lease/review-lease actions) does **not** depend on P1b and proceeds now on #761; only the attestation integration waits for P1b. The migration (0070 `task_leases.epoch`), the rebind op with grant/epoch CAS, and the lease-action epoch fence built ahead stand and are completed in the same lane.

### 4.6 Effect mediation
- **Brokered class** (non-idempotent external writes): review verdicts and task-linked GitHub writes via server-side tools. GitHub and the DB cannot be atomic, so the broker is a **saga/outbox**: effect rows with states `pending → succeeded | failed | ambiguous`, a stable idempotency/correlation key embedded in the external artifact, a reconciliation sweep that resolves `ambiguous` by querying GitHub for the key, and bounded retry rules (retry `failed` idempotently; never blind-retry `ambiguous`). `submit_review_verdict` layers junk-verdict quarantine (content-empty blocking verdicts held for a human) on the same outbox.
- Permission profiles deny raw equivalents (`gh pr review`, etc.) for supervised agents.
- **Unbrokered writes**: documented at-least-once; reality-checked on resume. Attempt-branch pushes are brokered via `push_attempt_branch` (§3) — ref- and old-SHA-validated, force-with-lease, no child-held credential.

### 4.7 Attention economics (rowdiness)
Server-side delivery filtering: `wait_for_messages` returns only the agent's business by default — mentions, own threads, review requests, thread replies to the agent, lease/task events, broker outcomes, human messages; delivery scope set per charter (coordinator hears all; reviewer hears mentions + tasks). Filtering is **non-destructive and auditable**: the event is always retained; each suppression records `{event, policy_version, decision, reason}` so decisions are replayable and a charter change can backfill. Charters in the manifest: role sentence + speak-when rules + delivery scope. Status lane absorbs eagerness; server-side rate caps as backstop.

### 4.8 Provider adapters (tiered floor)
Interface: `spawn / resume / poke / stop / capabilities`. Required floor: headless launch + MCP config + observable exit. Progressive (capability-negotiated, each claim backed by a passing spike cell): resume, mid-turn injection, transcript access. The reconciler consumes the negotiated set — e.g. no poke ⇒ attention ladder skips rung 2. Claude first; codex's existing `mcp_polling` delivery path is elevated in P2. For a no-resume provider the promise is **bounded recovery, not survival**: on process death or daemon restart, in-context state since the last checkpoint is lost; the work attempt, workspace, scratchpad, and outbox bound that loss and a fresh session resumes from them. Adapters must state this bound in `capabilities()` and the UI must surface it.

### 4.9 v1 scope gates
Cloud-backed rooms only — **decided** (a worker on cloud MCP cannot reach app-local sqlite storage); local rooms fail with a precise capability-gate error; transport abstracted so the backlogged daemon-owned local MCP endpoint (P3e) can add parity; Electron never becomes the local storage owner. Inspector parity via transcript tail / provider thread events. Permission mediation bridge for headless runtimes (#722-adjacent) before GA of supervised agents in permission-gated profiles.

## 5. Rollout & rollback (canonical acceptance criteria for every phase)

- Old event-turn engine remains the **default**; the supervised path ships behind a feature flag with a **per-room, per-provider kill switch**.
- **Ownership fence:** a logical agent is owned by exactly one engine at a time — enabling the supervised path for an agent atomically disables legacy delivery for it (and vice versa); mixed-version tests must cover the flip in both directions. Shadow mode, if used, is strictly observe-only (no room writes, no lease actions).
- All schema changes **expand-only** until the deletion gate; mixed-version (old engine + supervised path coexisting) covered by tests.
- **Deletion gates** — the engine, its queues, watchdogs, and status ladder are deleted only after: (a) ≥1 week soak of supervised agents across ≥3 rooms including overnight periods, (b) brokered-authority cutover for review verdicts, (c) worker-bearer enforcement on by default, (d) inspector + permission parity confirmed, (e) dual independent reviewer approval against the recorded evidence for gates (a)–(d), with EmmyMay holding an optional override — authority was delegated, so owner sign-off is an override path, not a mandatory gate.
- Every PR: squash to one commit, rebase-merge to `staging`, **both reviewers' explicit non-blocking verdicts** (neither reviews own changes; no time-based defaults; reviewer loss = hold + escalate to EmmyMay), staging commit verified post-merge.

## 6. Completion ladder (dependency edges explicit)

**F — Auth foundation (first coding work)**
- F1. Server: `authKind=agent_session` worker bearer (scope/expiry/revocation/generation) + auth-middleware enforcement + the test set in §3. Expand-only.
- F2. MCP runtime: worker-bearer mode that never loads saved owner auth; token redaction.
- F3. Supervisor host grant: provisioning flow (UI), Keychain storage, server-side revocation, sign-out/uninstall semantics.
- Edges: F1 → F2 → (P0 live cells, P1c) ; F1 → F3 → P1c.

**P0 — Spike matrix** (safe cells may run before F; live cells strictly after F2)
- Safe (fake/local, no live credentials): capability probes — launch mechanics, injection mechanics against a stub, transcript tail parsing, codex `mcp_polling` behavior read.
- Live (post-F2, worker bearer only): (a) idle poll ≥15 min; (b) kill -9 during generation → resume; (c) kill during local tool call → resume; (d) kill after external side effect pre-checkpoint — side-effect target is a dedicated sandbox resource with correlation marker `spike-run:<uuid>`, idempotent cleanup, never the product repo; (e) resumed session cannot act on old session's lease (expected failure → evidence for P1.5); (f) poke latency; (g) permission round-trip; (h) worker-bearer isolation — child can read no owner secret from env/argv/files.
- Deliverable: findings message + go/no-go on codex resume/injection. (d) validates or kills the effect-journal design.

**P1 — Daemon + Claude adapter** (P1a → P1b → P1c → P1d → P1e)
- P1a. Daemon skeleton: flock + generation, crash-consistent CAS manifest, three-axis state, versioned socket protocol. macOS-only, gated.
- P1b. Work durability: `task_work_attempt` + `execution_generation` records, per-work-attempt worktrees from daemon-owned clones, GC with protected classes, post-mortem diffs.
- P1c. Claude adapter (gated on P0 findings + F2/F3): spawn/resume/poke/stop per proven mechanics, capability negotiation, worker bearer via env, transcript tail → runtime evidence.
- P1d. Reconciler: convergence, backoff, crash-loop quarantine, graduated attention with pre-rebind lease rule, stale-daemon/duplicate-reconciler/restart-during-rebind tests, lifecycle via status lanes.
- P1e. Electron: detached daemon lifecycle, manifest-backed Add Agent (cloud rooms only; visible gate elsewhere), honest three-axis detail UI, protocol-version handoff without blind worker kills.

**P1.5 — Server rebind** (after P1b, before P1d; blocks resume-enable)
- Lease epochs + fenced rebind per §4.5 (grant-gated HTTP route). The mandatory epoch sweep across every lease-authorized write + barrier-paused HTTP race tests do **not** depend on P1b and proceed now. Only the **terminal-attestation predicate** waits on P1b's `execution_generation` terminal state; P1d is the runtime consumer that produces the attestation. Enables the P1d resume path.

**P2 — Codex + migration**
- P2a. Codex adapter on `mcp_polling` (capabilities per spike). P2b. Port rooms provider-by-provider behind the flag. P2c. Inspector + permission parity. P2d. Test-suite rewrite (~24 coupled files). P2e. Engine deletion — only after §5 gates.

**P3 — Mediation + hardening**
- P3a. Brokered verdict authority: `submit_review_verdict` + quarantine + outbox; profile denial of raw equivalents. P3b. Delivery filtering + charters. P3c. Budgets/rate caps + recycle policy. P3d. Daemon packaging (login item) + Windows parity task.

**Canonical execution order (normative, resolves phase-number vs sequence ambiguity):**
`F → P0 → (P1 ∥ P1.5) → P2a–P2d → P3a → P2e (engine deletion) → P3b–P3d`
P3a precedes P2e by construction — deletion gate (b) cannot be satisfied otherwise. Phase numbers are groupings, not sequence.

**Backlog (explicitly outside completion):** local-rooms parity via a daemon-owned local MCP endpoint (cloud-only v1 is a decided constraint); Windows platform parity.

**Completion** = P2a–P2e + P3a–P3d done + deletion gates passed. Not P1e, and not the backlog items.

## 7. Defect log (found during planning, tracked separately)
- `update_task` silently drops `description` edits (chip filed).
- Interrupt-reason laundering in codex-supervisor status reconciliation (superseded by this rewrite; do not patch separately unless the rewrite slips).
