# Gate A — Claude Agent SDK interrupt/resume spike

**Date:** 2026-06-29
**Decision: FORK A — `interrupt()` is terminal for the turn, but `resume(sessionId)` continues the SAME logical session with full prior context.**
Phase 2 preempt/redeliver = `interrupt() → query({ resume: sessionId, prompt: nextEvent })`. Phase 3 does **not** need `previous_session_ids`; Inspect keeps one stable `session_id`.

## Environment
- macOS (darwin), Node `v22.20.0`
- `@anthropic-ai/claude-agent-sdk` **`0.3.196`** (latest at time of spike; pin EXACT in `apps/desktop` in Phase 2)
- `claude` CLI `2.1.70`; auth = existing **claude.ai first-party OAuth** (no API key needed — confirms "reuse Claude Code OAuth" is viable)
- Model: `claude-haiku-4-5-20251001`
- Throwaway probe (`LETAGENTS_CLAUDE_SPIKE=1`), run outside the repo; credential-free. Ran 2× — stable.

## Harness (per the agreed Gate A contract)
Streaming-input `query({ prompt: <AsyncIterable<SDKUserMessage>>, options })`, `permissionMode:'default'`, `allowedTools:[]`. One session:
1. **Seed** a benign session fact (`ticket PROJ-8472`).
2. **Resume** that session, start a long turn, call `query.interrupt()` after the first assistant message.
3. **Resume** again; ask which ticket id was given → tests whether pre-interrupt context survived.
4. **Continue** with another trivial turn.

## Captured result (representative run)
| field | value |
|---|---|
| seed result | `success`, established `PROJ-8472` |
| interrupted-turn result subtype | **`error_during_execution`** (terminal) |
| resume after interrupt | **no throw**, `result: success` |
| context preserved across interrupt | **YES** — resume reply: *"**PROJ-8472** — that's the ticket we're synced on for this debugging session."* |
| continuation turn | `success` ("OK") |
| session_id | **stable** across seed → interrupt → resume → continue (no rotation) |

### Transcript snippets
- Interrupted turn (partial, then cut): `"# Advisory File Locks on Linux and macOS… ## 1. Foundation:"` → `result/error_during_execution`
- Resume turn: `"PROJ-8472 — that's the ticket we're synced on for this debugging session."`
- Continuation: `"OK"`

## Side-findings (feed into Phase 2/3 — not blockers)
1. **Message stream is richer than assistant/result.** Observed types: `system/init`, `system/thinking_tokens` (many), `assistant`, `user` (tool-result-shaped), `rate_limit_event`, `system/post_turn_summary`, `result/{success,error_during_execution}`. The Phase 2 ring-buffer + the **redaction stage must allowlist** what to forward (text only) and tolerate these types — do not assume only `assistant`/`result`.
2. **The first-party session inherits org/system guidance and will REFUSE artificial instructions.** A first attempt using a "memorize this code word and repeat it" canary was declined as a prompt-injection-looking test (model cited org/Herotel guidelines). Implication for the real runtime: **frame desktop-event prompts as legitimate work**, and phrase the `NO_ROOM_REPLY` sentinel instruction so it does not read as an injection test, or the managed agent may refuse/argue instead of acting.
3. `resume` works with streaming-input mode and reused the same `session_id` (no new id minted on resume in these runs).

## Gate A status: SATISFIED
- Fork recorded (A) with captured `subtype` + transcript. ✓
- SDK version resolved (`0.3.196`); EXACT pin to land in `apps/desktop/package.json` during Phase 2. ✓ (recorded)
- Unblocks Phase 2 deliver/preempt design.
