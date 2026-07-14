# Room Agents Rewrite — Canonical Plan

- **Version:** v10 (supersedes v9; formalizes the native-harness/MCP two-channel architecture and removes the provider-auth projection, isolated-HOME, and worker-bearer program as launch prerequisites)
- **Status:** v6-v9 approved and merged to staging (PRs #753/#754/#756/#762). Each revision becomes authoritative only when merged. **Author (RiverRiver) is excluded from this document's review gate.** Plan gate reviewers: PeakCloud (architecture) + RiverSilver (independent evidence check); EmmyMay remains override authority.
- **Authority:** once merged, this document is the single normative source. Board tasks are cut from it verbatim; chat messages never amend it — revisions are PRs to this file.
- **Decision log:** EmmyMay 2026-07-14: rewrite from scratch, no patches; lightweight model implements; PeakCloud + RiverRiver hold final merge say on **implementation PRs** (author always excluded from any gate they authored). Cloud-backed rooms only in v1; brokered external writes; supervisor daemon in phase 1. EmmyMay clarification (focus_37 msg_706/msg_709): provider CLIs/apps already own execution permissions; LetAgents must bring those agents into a shared room, not create a second permission system around them.

## 1. Evidence

Three desktop-managed reviewers died in one night (2026-07-14, focus_34), each to a distinct structural flaw of the event-turn model:

1. **StoneRiver** (codex): the 60-minute unpausable turn ceiling killed it mid-review. A half-formed `"sdf"` `CHANGES_REQUESTED` escaped to PR #750 and hard-blocked the pipeline. The status reconciler then overwrote the kill reason (`last_error: null`).
2. **BrightHarbor** (codex): dead 33 seconds after being added, during its acknowledgement turn, amid dev restarts of the host app. `process.on("exit")` kills every spawned agent process in every room.
3. **SummitFern** (claude): its review turn was preempted by a *liveness status message* (`shouldPreemptOnEnqueue: () => true`, claude-code-runtime.ts). The preempted event was never re-delivered; the review evaporated while the session stayed "alive".

Every pull-based MCP worker survived the same night doing heavier work. The push model's wrong axioms: events are pushed at agents (forcing an unanswerable preempt-vs-queue choice), the turn is the unit of existence (work has no durable identity), and the GUI process is the host (agent lifetime coupled to an app restarted constantly during development).

## 2. Thesis

An agent is a **durable intent** ("X reviews in room Y"), realized by a **disposable headless process**, supervised to convergence. Room agents are pull-based MCP workers (`register_agent_session` → `wait_for_messages` → work → `send_message`). The desktop app stops being the runtime and becomes **control plane + viewport + local resource broker**.

## 3. Two-channel contract and permission ownership

A room agent has one identity but two independent channels:

1. **Native harness channel** — the provider CLI/desktop host talks directly to its engine. This channel owns process lifecycle, prompts, interrupts, transcript/continuation state, observability, and the provider's existing permission model. It is how a human talks to an agent in Claude Code, Codex, Cursor, or another supported host. It is not MCP.
2. **MCP workplace channel** — the running agent calls LetAgents MCP to join a room, poll, send/reply, inspect the board, hold leases, and publish workflow artifacts. In the room it appears as its registered agent identity and session generation. MCP is the workplace, not the agent runtime.

The supervisor coordinates these channels; it does not collapse them. A native harness may keep a long-lived process, run turns inside an app server, or recreate a process from a continuation. The adapter reports those capabilities honestly while the durable intent, work attempt, room cursor, and workspace survive above the provider process.

**Permission ownership (ratified by EmmyMay, focus_37 msg_706/msg_709):**

- The provider's existing launch configuration is the sole execution-permission authority. For Codex this includes the current Add Agent choices such as Full access, Ask before writes, Sandboxed writes, and Read-only and their existing `approvalPolicy`/`sandboxPolicy` mapping. Claude Code, Cursor, and future providers keep their native equivalents.
- LetAgents MUST NOT add a second user-facing scope/token/profile ceremony, reinterpret the selected provider policy, or require users to assemble a shadow HOME or credential projection. Normal provider sign-in remains normal provider sign-in.
- The desktop passes the selected provider launch policy to the native harness unchanged. Any permission question raised by the provider returns through the native channel and is rendered by the desktop; MCP delivery must never preempt or erase it.
- LetAgents room authentication and `agent_session_id` remain transport identity and attribution. Registration/session rotation may be automatic, but they are not a replacement permission model for the provider process and are not a prerequisite for launching the provider under its existing policy.
- Existing worker-bearer, host-grant, redaction, or configuration-isolation work may remain as optional defense-in-depth and internal control-plane hardening. None may gate P0 live interoperability, provider adapters, durability, or the supervised launch path unless a separate threat model and owner-approved product requirement explicitly promote it.
- Provider workspace instructions, hooks, plugins, MCP servers, and normal CLI configuration are governed by that provider's selected policy exactly as in the native CLI/app. The adapter may add the LetAgents MCP server needed for the workplace channel, but must not silently disable the user's configured provider environment.

Required tests: selected provider policy reaches the native harness unchanged; permission prompts round-trip without lost work; the agent joins the intended room and preserves attribution; app restart and provider restart preserve the room cursor/work attempt; MCP messages cannot preempt an in-flight native turn; unsupported native capabilities are surfaced rather than simulated.

## 4. Architecture

### 4.1 Supervisor daemon (phase 1)
Standalone Node process (no Electron imports), spawned detached and observed by Electron but surviving its exit — the reconciler must not live in the UI failure domain. Singleton flock + monotonic supervisor generation; manifest and rebind writes CAS on generation. Control surface: unix socket, JSON-lines, versioned protocol (mismatch = explicit failure; upgrades do a negotiated generation-bump handoff that never blind-kills workers). **Platform scope v1: macOS only** — visibly capability-gated elsewhere; Windows parity is a tracked follow-up task.

### 4.2 Desired-state model (three axes)
- Manifest `desired_state`: `running | paused | stopped`
- Observed execution: `absent | starting | idle | working | checkpointing | pausing | paused | recovering | stopping | stopped | failed`
- Policy condition: `none | quarantined | coordination_blocked | auth_blocked | budget_blocked | security_blocked` (`coordination_blocked` = recovery is held by lease/rebind state, e.g. the pre-rebind rule in §4.4; enters from `recovering`, exits on rebind success, lease release/expiry, or human direction)

Manifest entries: `{id, room_id, display_name, provider, model, charter, desired_state, provider_launch_policy, created_by, created_at}`. `provider_launch_policy` records the user's existing provider-native selection; it is passed through, not interpreted as a LetAgents permission scope. Manifest writes are crash-consistent (temp file + fsync + atomic rename + checksum; checksum validated before load). Deletion = GC of a stopped entry, never the representation of a kill. Every transition appends `{at, from, to, cause, actor, generation}` to an audit log that is archived/rotated when it reaches its bound — never truncated in place. UI shows all three axes honestly (e.g. desired=running, observed=stopped, blocked_by=crash_loop).

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

**Control surface (ratified):** rebind is exposed as a **supervisor-authenticated HTTP route** (`POST /supervisor-host-grants/:grantId/leases/:leaseId/rebind`), NOT an MCP tool. Supervisor-authority operations are control-plane routes the daemon calls; the daemon is not an MCP room worker. The existing host grant is an internal fencing identity for this route, not a provider launch permission and not a user-facing setup gate. The route remains default-deny in the supervisor-grant route registry. (Supersedes the "MCP tool" wording in the task_13 board text.)

**Both sessions bound to the grant:** both the predecessor (`from`) and successor (`to`) session must be `session_kind==='worker'`, owned by the grant's owner, and carry `supervisor_grant_id === grant.grant_id` — so a grant for host A cannot seize a same-agent-key lease whose predecessor belongs to host B.

**Terminal attestation (required for final P1.5 approval):** generic `session.ended_at` is *auth* terminality, not *process/work* terminality — an ended session can still leave a live OS process writing the reused workspace (two-writers hazard). The complete rebind therefore consumes a **server-persisted terminal/revocation attestation record** — not an opaque flag — with the exact tuple `{lease_id, epoch, from_session, work_attempt_id, execution_generation_id, supervisor_generation}` plus a `cause` and `attested_at` timestamp, written by the authoring supervisor generation and **consumed exactly once** inside the rebind transaction (a used attestation cannot be replayed). It reads P1b's `execution_generation` terminal state. The interim `from`-session-ended predicate is **not sufficient and is not a shippable final state**: final P1.5 approval is gated on the attestation, and no known-residual rebind merges.

**Safe restart order (normative — P1d executes this, P1.5 enforces it):** (1) kill the old worker OS process and **wait** for confirmed exit; (2) record the immutable `execution_generation` terminal payload and take the exclusive single-writer workspace fence; (3) register the successor room session **without** spawning its provider child yet; (4) consume the terminal attestation and commit the fenced rebind (epoch+1) in one transaction; (5) only then spawn/resume the successor through the native harness with the user's selected provider policy, **retaining** the workspace fence across the handoff. No step may spawn the successor process before the rebind commits.

**Sequencing (linear, no cycle):** **P1b (task_15) → P1.5 (this server fence + attestation) → P1d (runtime consumer)**. P1.5 defines and persists the attestation and enforces the epoch fence; **P1d is the consumer** — it produces the attestation by kill-confirming the predecessor OS process and holding a single-writer workspace fence before spawning the successor, then presents it to the rebind. P1.5 depends on P1b's attempt model, not on P1d. The mandatory epoch sweep across *every* lease-authorized `agent_session` write surface (task mutations, artifact writes, lease/review-lease actions) does **not** depend on P1b and proceeds now on #761; only the attestation integration waits for P1b. The migration (0070 `task_leases.epoch`), the rebind op with grant/epoch CAS, and the lease-action epoch fence built ahead stand and are completed in the same lane.

### 4.6 Effect mediation
- **Brokered class** (non-idempotent external writes): review verdicts and task-linked GitHub writes via server-side tools. GitHub and the DB cannot be atomic, so the broker is a **saga/outbox**: effect rows with states `pending → succeeded | failed | ambiguous`, a stable idempotency/correlation key embedded in the external artifact, a reconciliation sweep that resolves `ambiguous` by querying GitHub for the key, and bounded retry rules (retry `failed` idempotently; never blind-retry `ambiguous`). `submit_review_verdict` layers junk-verdict quarantine (content-empty blocking verdicts held for a human) on the same outbox.
- Brokering is a durability/idempotency mechanism, not a replacement for provider permissions. The provider continues to decide whether a command may run. LetAgents tools steer coordinated workflow writes through the outbox where exact retry semantics matter.
- **Unbrokered writes**: documented at-least-once; reality-checked on resume. Attempt-branch pushes may use `push_attempt_branch` — ref- and old-SHA-validated, force-with-lease — for deterministic retry behavior, without requiring the adapter to suppress the provider's normal Git environment.

### 4.7 Attention economics (rowdiness)
Server-side delivery filtering: `wait_for_messages` returns only the agent's business by default — mentions, own threads, review requests, thread replies to the agent, lease/task events, broker outcomes, human messages; delivery scope set per charter (coordinator hears all; reviewer hears mentions + tasks). Filtering is **non-destructive and auditable**: the event is always retained; each suppression records `{event, policy_version, decision, reason}` so decisions are replayable and a charter change can backfill. Charters in the manifest: role sentence + speak-when rules + delivery scope. Status lane absorbs eagerness; server-side rate caps as backstop.

### 4.8 Provider adapters (tiered floor)
Interface: `spawn / resume / poke / stop / capabilities`. Required floor: native-harness launch/attach + LetAgents MCP configuration + observable exit. Every adapter receives the existing provider launch policy from the desktop and must preserve it unchanged. Progressive capabilities (each backed by a passing spike cell): resume, mid-turn injection, transcript access, permission-prompt bridging. The reconciler consumes the negotiated set — e.g. no poke ⇒ attention ladder skips rung 2. Codex is first because the current app-server path can run as a durable background process; Claude Code and Cursor follow through their native harnesses without pretending they share Codex's process model. For a no-resume provider the promise is **bounded recovery, not survival**: on process death or daemon restart, in-context state since the last checkpoint is lost; the work attempt, workspace, scratchpad, and outbox bound that loss and a fresh session resumes from them. Adapters must state this bound in `capabilities()` and the UI must surface it.

### 4.9 v1 scope gates
Cloud-backed rooms only — **decided** (a worker on cloud MCP cannot reach app-local sqlite storage); local rooms fail with a precise capability-gate error; transport abstracted so the backlogged daemon-owned local MCP endpoint (P3e) can add parity; Electron never becomes the local storage owner. Inspector parity via transcript tail / provider thread events. Provider-native permission prompts and selected launch modes must round-trip through the desktop before GA; LetAgents does not define an additional permission profile.

## 5. Rollout & rollback (canonical acceptance criteria for every phase)

- Old event-turn engine remains the **default**; the supervised path ships behind a feature flag with a **per-room, per-provider kill switch**.
- **Ownership fence:** a logical agent is owned by exactly one engine at a time — enabling the supervised path for an agent atomically disables legacy delivery for it (and vice versa); mixed-version tests must cover the flip in both directions. Shadow mode, if used, is strictly observe-only (no room writes, no lease actions).
- All schema changes **expand-only** until the deletion gate; mixed-version (old engine + supervised path coexisting) covered by tests.
- **Deletion gates** — the engine, its queues, watchdogs, and status ladder are deleted only after: (a) ≥1 week soak of supervised agents across ≥3 rooms including overnight periods, (b) brokered-authority cutover for review verdicts, (c) at least Codex + one other provider prove native-channel/MCP-room interoperability including restart continuity, (d) inspector + provider-permission round-trip parity confirmed, (e) dual independent reviewer approval against the recorded evidence for gates (a)–(d), with EmmyMay holding an optional override — authority was delegated, so owner sign-off is an override path, not a mandatory gate.
- Every PR: squash to one commit, rebase-merge to `staging`, **both reviewers' explicit non-blocking verdicts** (neither reviews own changes; no time-based defaults; reviewer loss = hold + escalate to EmmyMay), staging commit verified post-merge.

## 6. Completion ladder (dependency edges explicit)

**F — Existing identity/control-plane hardening (non-blocking)**
- F1. `authKind=agent_session` and worker-session lifecycle may be used for room attribution and revocation.
- F2. Alternate MCP runtime auth and token redaction remain optional defense-in-depth.
- F3. Supervisor host grants remain the internal authority for supervisor-only lifecycle/rebind routes.
- These landed foundations MUST NOT block real-provider P0, native adapter work, or supervised launch. Only the specific rebind operation depends on a valid internal supervisor identity.

**P0 — Live interoperability + continuity matrix**
- Safe/fake: launch mechanics, injection against a stub, transcript tail parsing, terminal ordering, workspace fencing, and Codex `mcp_polling` behavior.
- Live, using the provider's real configured launch path: (a) idle poll ≥15 min; (b) Claude/Codex/Cursor messages and threaded replies interoperate with correct attribution; (c) kill -9 during generation → restart/resume with transcript and room cursor intact; (d) kill during local tool call → terminal captured and loop recovers; (e) kill after an external side effect pre-checkpoint against a dedicated sandbox resource with `spike-run:<uuid>` correlation and idempotent cleanup, never the product repo; (f) resumed session cannot act on the old session's lease; (g) addressed-message poke latency; (h) the selected provider launch policy and permission prompts round-trip unchanged; (i) desktop quit/relaunch does not kill supervised work.
- Deliverable: per-cell findings + timings + go/no-go on Codex durable launch/resume and an explicit capability table for every provider tested. The external-effect cell validates or kills the effect-journal design.

**P1 — Daemon + first native adapter** (P1a → P1b → P1c → P1d → P1e)
- P1a. Daemon skeleton: flock + generation, crash-consistent CAS manifest, three-axis state, versioned socket protocol. macOS-only, gated.
- P1b. Work durability: `task_work_attempt` + `execution_generation` records, per-work-attempt worktrees from daemon-owned clones, GC with protected classes, post-mortem diffs.
- P1c. Codex native adapter (gated on P0 mechanics): spawn/attach/resume/poke/stop per proven app-server mechanics; pass the existing Add Agent launch policy unchanged; configure LetAgents MCP as the workplace channel; transcript tail → runtime evidence.
- P1d. Reconciler: convergence, backoff, crash-loop quarantine, graduated attention with pre-rebind lease rule, stale-daemon/duplicate-reconciler/restart-during-rebind tests, lifecycle via status lanes.
- P1e. Electron: detached daemon lifecycle, manifest-backed Add Agent (cloud rooms only; visible gate elsewhere), honest three-axis detail UI, protocol-version handoff without blind worker kills.

**P1.5 — Server rebind** (after P1b, before P1d; blocks resume-enable)
- Lease epochs + fenced rebind per §4.5 (supervisor-authenticated HTTP route). The mandatory epoch sweep across every lease-authorized write + barrier-paused HTTP race tests do **not** depend on P1b and proceed now. Only the **terminal-attestation predicate** waits on P1b's `execution_generation` terminal state; P1d is the runtime consumer that produces the attestation. Enables the P1d resume path.

**P2 — Cross-provider adapters + migration**
- P2a. Claude Code adapter through its native CLI/harness with truthful process/resume capabilities. P2b. Cursor adapter, then port additional providers one-by-one behind the flag. P2c. Cross-provider room interoperability, inspector parity, and provider-permission round-trip. P2d. Test-suite rewrite (~24 coupled files). P2e. Engine deletion — only after §5 gates.

**P3 — Mediation + hardening**
- P3a. Brokered verdict authority: `submit_review_verdict` + quarantine + outbox for idempotent workflow effects. P3b. Delivery filtering + charters. P3c. Budgets/rate caps + recycle policy. P3d. Daemon packaging (login item) + Windows parity task.

**Canonical execution order (normative, resolves phase-number vs sequence ambiguity):**
`P0 → (P1 ∥ P1.5) → P2a–P2d → P3a → P2e (engine deletion) → P3b–P3d`
P3a precedes P2e by construction — deletion gate (b) cannot be satisfied otherwise. Phase numbers are groupings, not sequence.

**Backlog (explicitly outside completion):** local-rooms parity via a daemon-owned local MCP endpoint (cloud-only v1 is a decided constraint); Windows platform parity.

**Completion** = P2a–P2e + P3a–P3d done + deletion gates passed. Not P1e, and not the backlog items.

## 7. Defect log (found during planning, tracked separately)
- `update_task` silently drops `description` edits (chip filed).
- Interrupt-reason laundering in codex-supervisor status reconciliation (superseded by this rewrite; do not patch separately unless the rewrite slips).
