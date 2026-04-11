# Handoff: Long-running LetAgents + headless Antigravity worker

This document summarizes **repo changes** intended for **multi-hour coordination**, **room polling**, **cascade discovery/reuse**, and how they fit together. It is written so another agent (e.g. Opus in Antigravity) can continue without re-deriving context from chat alone.

---

## 1. Goals (product)

- Agents using **LetAgents** (MCP + `letagents.chat` or self-hosted API) can **poll for many hours** without treating “no new lines yet” as “stop the mission.”
- Operators can **raise the HTTP long-poll ceiling** when they control the API + MCP processes.
- **Headless Antigravity** (`headless_antigravity_worker.mjs`) can **reuse the IDE’s active cascade**, **resolve which cascade is live**, and **scan multiple LS processes** so messages go to the **correct instance** (patterns borrowed from **Antigravity-Deck** and **Antigravity-Link**).

---

## 2. LetAgents API + MCP: configurable poll cap

### Code

| File | Change |
|------|--------|
| `src/shared/poll-timeout-cap.ts` | **New.** Exports `getPollTimeoutCapMs()` — reads `LETAGENTS_POLL_MAX_MS`, default **180000**, max clamp **24h**. |
| `src/api/server.ts` | `parsePollTimeout()` uses `getPollTimeoutCapMs()` instead of a hard-coded **180000** cap for `GET …/messages/poll`. |
| `src/mcp/server.ts` | `wait_for_messages` uses the same cap; **tool descriptions** updated for `send_message`, `read_messages`, `wait_for_messages`; client `AbortSignal.timeout` buffer is **+120s** when server wait **> 120s**. |

### Environment variable

- **`LETAGENTS_POLL_MAX_MS`** (optional)  
  - Applies to **both** the **API** process and the **MCP** process (they must agree: MCP must not request a timeout above what the API allows).  
  - Example for ~10 hours: **`36000000`**.  
  - Default if unset: **180000** (3 minutes), preserving previous behavior.

### Hosted vs self-hosted

- **Self-hosted:** set `LETAGENTS_POLL_MAX_MS` on the processes **you** run (`dev:api`, `letagents` MCP, etc.).  
- **`https://letagents.chat` (hosted):** end users only set MCP `env` in the client; **whether** long single polls are allowed is determined by **operators** of that deployment (they must set the same variable on **their** API/MCP servers). The code supports it; **policy** is deployment-specific.

### Agent behavior (documented in MCP tool strings + `AGENTS.md`)

- Call **`wait_for_messages`** in a **loop** with **`after_message_id`** from the last processed message.  
- An **empty** `messages` array usually means **timeout / no new lines**, not necessarily “task complete.”  
- If another participant posted a **premature closing** (“tell me when there are messages”), use **`send_message`** with a short **continue** instruction.

See **`AGENTS.md`** section **“Long room watches (agents)”** and the updated **`wait_for_messages`** / **`send_message`** / **`read_messages`** tool descriptions in **`src/mcp/server.ts`**.

---

## 3. Headless Antigravity worker: cascade discovery & reuse

**File:** `headless_antigravity_worker.mjs` (repo root, not under `src/`).

### Borrowed semantics

- **`GetAllCascadeTrajectories`** + defensive JSON parsing (Deck’s **`trajectorySummaries`** map vs Link-style **arrays**).  
- **Active cascade pick:** prefer statuses containing **RUNNING** / **WAITING**, else fallback to last trajectory (Link-style).  
- **Multi-LS scan:** rank processes (workspace matching `ANTIGRAVITY_WORKSPACE_URI` / git root first, then other workspace LS, then core), probe each until the desired cascade appears or an active one is found.

### New exports (for tests or other scripts)

- `parseTrajectorySummaries(parsed)`  
- `pickActiveCascadeIdFromMap(map)`

### CLI flags

| Flag | Purpose |
|------|---------|
| `--list-cascades` | Print `GetAllCascadeTrajectories` (raw + parsed map + `pickedActive`) for the **currently selected** LS target, then exit. |
| `--resolve-cascade` | If **`ANTIGRAVITY_CASCADE_ID`** is unset, pick an active cascade id from **`GetAllCascadeTrajectories`** on that target. |
| `--scan-all-ls` | With **`ANTIGRAVITY_CASCADE_ID`** and/or **`--resolve-cascade`**: scan **all** candidate LS processes until the cascade is found or an active trajectory is chosen; **rebinds** `baseUrl` + CSRF to that instance. |

### Environment variables (cascade)

| Variable | Purpose |
|----------|---------|
| `ANTIGRAVITY_CASCADE_ID` | If set, **skip `StartCascade`**; send/poll this existing conversation. |
| `ANTIGRAVITY_RESOLVE_CASCADE=1` | Same as **`--resolve-cascade`** when no id in env. |
| `ANTIGRAVITY_SCAN_ALL_LS=1` | Same as **`--scan-all-ls`**; requires explicit cascade id **and/or** resolve mode (see worker throw message if misconfigured). |

### Flow change

- **`runOneCascade(streamMethod, existingCascadeId)`** — when `existingCascadeId` is set, **no `StartCascade`**; otherwise behavior matches the previous single-path.

### Related scripts (unchanged in this effort, still relevant)

- `letagents_antigravity_wake.mjs` — long-poll room + spawn worker; can pass extra flags via **`ANTIGRAVITY_WORKER_FLAGS`** (e.g. `--resolve-cascade` / `--scan-all-ls` once wired by operator).

---

## 4. Deck-style polling (conceptual, not duplicated in MCP)

**Antigravity-Deck** uses **short interval ticks** (e.g. **1s** active / **5s** idle) for LS trajectory polling — **bursts**, not one infinite HTTP call. **LetAgents** room waits use **long-poll** with a **bounded** `timeout` per request; **multi-hour** behavior is **many** polls (or fewer very long polls if `LETAGENTS_POLL_MAX_MS` is raised). Both are valid; do not conflate “Deck LS poller” with “LetAgents `messages/poll`” as the same HTTP shape.

---

## 5. Build / ship notes

- `npm run build` compiles **`src/shared/poll-timeout-cap.ts`** into **`dist/shared/`** (included in npm `files` pattern).

---

## 6. Suggested next steps for a follow-up agent

1. **Hosted `letagents.chat`:** confirm with maintainers whether **`LETAGENTS_POLL_MAX_MS`** should be set in production and to what value; document for users if yes.  
2. **`letagents_antigravity_wake.mjs`:** optionally forward **`ANTIGRAVITY_WORKER_FLAGS="--resolve-cascade"`** (and document in that file’s header).  
3. **Headless “5%”** (`CURSOR_HANDOFF.md`): reactive / UI dormancy remains a **separate** research thread; the worker + LetAgents loop **does not** replace that fix.  
4. Optional **unit tests** for `parseTrajectorySummaries` / `pickActiveCascadeIdFromMap` (exported from worker — may need a small test harness since the worker is `.mjs` at repo root).

---

## 7. Index of touched files (this effort)

- `headless_antigravity_worker.mjs` — cascade reuse, resolve, scan, list-cascades, parsers.  
- `src/shared/poll-timeout-cap.ts` — **new**.  
- `src/api/server.ts` — poll timeout cap.  
- `src/mcp/server.ts` — cap alignment, tool docs, client timeout buffer.  
- `AGENTS.md` — long watches + table tweak.  
- `docs/AGENT_HANDOFF_LONG_RUNS_AND_HEADLESS.md` — **this file**.  
- `README.md` — link to this doc + optional MCP env example (if added in same commit).  
- `CURSOR_HANDOFF.md` — pointer to this doc (if added).
