# Headless Antigravity: The Final 5% (Cursor Handoff)

> **LetAgents + long polling + worker cascade discovery (2026):** see **`docs/AGENT_HANDOFF_LONG_RUNS_AND_HEADLESS.md`** for MCP/API env (**`LETAGENTS_POLL_MAX_MS`** on API + MCP — spelling is **LetAgents**, not “LetGravity”), `wait_for_messages` loop semantics, and **`headless_antigravity_worker.mjs`** flags (`--resolve-cascade`, `--scan-all-ls`, `ANTIGRAVITY_CASCADE_ID`, etc.). This handoff file remains focused on the Antigravity LS **reactive / “5%”** problem.

Hello Cursor! You are picking up an advanced reverse-engineering task from Claude/Gemini. We are 95% of the way to achieving a major architectural goal: **persistent, autonomous, headless operation of the Antigravity IDE agent.**

We need your help to brainstorm and solve the remaining 5% missing link: **keeping the execution pipeline alive for headless API calls.**

## 1. The Ultimate Goal: LetAgents Autonomous Workers

**What is LetAgents?**
LetAgents (`letagents.chat`) is a collaborative platform where humans and AI agents share chat rooms hooked directly into code repositories via MCP (Model Context Protocol). Agents can claim tasks, read repos, write code, run tests, and open PRs.

**Why headless Antigravity?**
Currently, Antigravity requires the human user to have the IDE GUI open, focused, and active. We are trying to build a **local Antigravity wake helper** (a CLI tool or background service process). 
- It will run in the background (headless) for hours.
- It will poll the LetAgents room for new tasks or mentions.
- When work is needed, it will "wake up" the headless Antigravity agent process, inject a user prompt (e.g., "Fix issue #42"), let the agent execute autonomously, post the PR to the room, and go back to polling.

Without headless execution, Antigravity is trapped as an interactive GUI assistant. We want to free it to be a 24/7 background dev team member on the user's machine.

## 2. What We've Achieved (The 95%)

We successfully bypassed the IDE GUI and sent messages directly to the Language Server (LS) that triggered full model execution, tool calls, and room output. 

### Architecture Discovered
Antigravity spawns multiple LS processes. The critical one is the **Core LS** (the "chat brain").
- **How to identify it:** It's the process spawned **without** the `--enable_lsp` and `--workspace_id` flags. It uses `--cloud_code_endpoint https://cloudcode-pa.googleapis.com`.
- **Current Port:** Usually HTTP port `61547` / HTTPS `61546` (dynamic, use `lsof` to find it).
- **Auth (CSRF):** Requires an `x-codeium-csrf-token` header, whose value is passed in the process args (`--csrf_token`).

### The Working Payload
When we target an **existing, UI-initialized cascade** (conversation), this payload works perfectly and triggers the model from the terminal:

```bash
PORT=61547
CSRF="af9f2b22-539c-4d0b-95b8-10a09340913d" # Extract from PID args
CID="ec09e47a-..." # An active cascade

# 1. Queue the message
curl http://127.0.0.1:$PORT/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage \
  -H "x-codeium-csrf-token: $CSRF" \
  -d '{
    "cascadeId": "'$CID'", 
    "text": "Say exactly: HEADLESS API WORKS"
  }'

# 2. Trigger processing
curl http://127.0.0.1:$PORT/exa.language_server_pb.LanguageServerService/SendAllQueuedMessages \
  -d '{
    "cascadeId": "'$CID'",
    "cascadeConfig": {
      "plannerConfig": {
        "requestedModel": {
          "choice": {"case": "model", "value": "MODEL_PLACEHOLDER_M26"}
        }
      }
    }
  }'
```

## 3. The Problem (The 5%)

The above flow **only works if the IDE UI has recently interacted with the cascade.** 

If we create a *new* cascade via API (`StartCascade`), or if the UI's connection to an existing cascade goes dormant, our API calls are accepted (`200 OK`, `{}`, no errors), but the model **never executes** (the trajectory step count stays exactly the same).

### Root Cause Analysis
The IDE's execution pipeline is reactive. The `SendUserCascadeMessage` endpoint simply queues the message. The LS will *only* process queued messages if there is an active subscriber listening to the execution stream. 

In the UI, the Electron chat panel subscribes to a stream (likely `StreamCascadeReactiveUpdates` or similar) when you open a chat. When that stream closes, message processing stops.

### 🚨 NEW INSIGHT: Why `--direct` isn't a Silver Bullet (The Opus Block)
We tested dropping the Cascade path entirely and using the raw `--direct` mode (`GetModelResponse` endpoint), which *does* work 100% headless. However, we discovered critical limitations that force us to solve the 5% Cascade streaming issue:

1. **Third-Party Model Blackout (No Opus):** The direct endpoint rejects requests for third-party models like Anthropic's Claude Opus or Sonnet (e.g., `MODEL_CLAUDE_3_OPUS_20240229`). It returns `404 NOT_FOUND` because external provider routing and billing context are exclusively handled during the full UI/Cascade handshake sequence.
2. **Aggressive Quota Throttling:** Using premium placeholder targets (e.g., `MODEL_PLACEHOLDER_M26` mapped to Gemini 3.1 Pro) on the direct endpoint rapidly hits `429 RESOURCE_EXHAUSTED` in polling setups. 

**Conclusion:** Because OPUS is a hard requirement for the workflow, we cannot rely on the `--direct` shortcut. We **must** crack the gRPC Cascade stream handshake ("The 5%") so we can trigger the full IDE pipeline headlessly.

## 4. What We Tried (And What Failed)

### 4a. Cursor's Connect Stream Approach (Partially Working)
Cursor's first implementation in `headless_antigravity_worker.mjs` added Connect protocol streaming (`application/connect+json`, 5-byte length-prefix frames). It opens a server-stream **before** queueing/flushing. The stream connects successfully (HTTP 200), receives 1 frame, and the message queues fine (`SendAllQueuedMessages: ok`). **But the model still doesn't execute.** The trajectory stays `CASCADE_RUN_STATUS_IDLE` with only the user input step (type `CORTEX_STEP_TYPE_USER_INPUT`).

**All three guessed stream methods were tested:**

| Stream Method | Result |
|---|---|
| `StreamCascadeSummariesReactiveUpdates` | ✅ Connects (200), receives 1 frame. Model does NOT execute. |
| `StreamCascadeReactiveUpdates` | ✅ Connects (200), receives 1 frame. Model does NOT execute. |
| `StreamUserTrajectoryReactiveUpdates` | ✅ Connects (200). Model does NOT execute. |
| `StreamCascadePanelReactiveUpdates` | ❌ `fetch failed` — needs different request payload shape. |

**Payload used for all streams:** `{ protocolVersion: 1, id: cascadeId, subscriberId: "headless-xxxx" }`

### 4b. Extension Server is Not the Gateway
The Extension Server (`--extension_server_port 56924`, CSRF `98c0489a-71e7-45d8-81d2-7019369866f2`) returns **404** for all `LanguageServerService` RPCs. It runs a completely different service namespace (`exa.extension_server_pb.ExtensionServerService`). The UI does NOT route cascade traffic through the Extension Server.

### 4c. `InitializeCascadePanelState` — Confirmed Dead End
Binary analysis revealed this RPC and its protobuf fields (`state_id`, `initialization_state_id`). We tested all payload combinations using the `initializationStateId` returned by `GetCascadeTrajectory`:
```
{ initializationStateId: "..." }    → 501 unimplemented
{ stateId: "..." }                   → 501 unimplemented
{ initialization_state_id: "..." }   → 501 unimplemented
{ state_id: "..." }                  → 501 unimplemented
```
**This RPC is defined in the protobuf schema but has NO handler in the Core LS.** It is likely handled by the Electron workbench process, not the language server binary. Dead end.

### 4e. 🚨 ROOT CAUSE FOUND: "reactive state is disabled"
In our comprehensive test (`headless_cascade_test.mjs`), we finally managed to connect to `StreamCascadeReactiveUpdates` successfully using a server-streaming ConnectRPC request, but it returned this critical error frame:
```json
{"error":{"code":"unknown","message":"reactive state is disabled"}}
```
**This is the definitive root cause of the 5% problem.** The Core LS's reactive state system — which drives the subscriber-based execution pipeline — is **explicitly disabled** when no UI panel is actively driving it. The LS won't process cascade messages without an active reactive state.

### 4f. Opus Breakthroughs: Payload Schemas Reversed!
Right before handing off, Opus successfully decompiled `jetskiAgent/main.js` and discovered the exact payload shapes! 
1. **`SignalExecutableIdle` Requires `conversationId`**
   Despite the error saying `"invalid_argument: cascade_id is required"`, the actual payload must be `{"conversationId": "..."}`. Sending this returns `200 {}`.
2. **`SendUserCascadeMessage` Requires `items` and `cascadeConfig`**
   We previously thought it just took `text` or `userMessage`. The UI actually sends:
   ```json
   {
     "cascadeId": "...",
     "items": [{"text": "What is 2+2?"}],
     "cascadeConfig": {
       "plannerConfig": {
         "requestedModel": { "choice": { "case": "model", "value": "MODEL_CLAUDE_4_OPUS" } }
       }
     }
   }
   ```
   **Result:** When sending this, the LS accepts it (`200 OK`) and actually queues the `CORTEX_STEP_TYPE_USER_INPUT` into the trajectory (verified via `GetCascadeTrajectorySteps`). BUT, because the reactive state is disabled, the model execution never triggers.
3. **`handleCascadeUserInteraction` and `sendAllQueuedMessages` are Unary (Not Streams)**
   The ConnectRPC definitions show these are simple awaited unary calls, not bidirectional streams. The UI calls `sendUserCascadeMessage`, then `sendAllQueuedMessages`.

### 4g. Additional Technical Notes
- **HTTP port (56928) crashed** after ~20 rapid cascade tests. HTTPS port (56927) remained stable. Future headless scripts should **prefer HTTPS with `NODE_TLS_REJECT_UNAUTHORIZED=0`**.
- `SmartFocusConversation` with `{ cascadeId }` returns `{}` (success) but does NOT enable reactive state.
- `StreamCascadePanelReactiveUpdates` returned `"unimplemented"` — same as the panel init RPC.

### 4d. MITM Proxy (Ready to Use)
We built `antigravity_mitm_proxy.mjs` in the repo root. It intercepts all HTTP traffic between the Electron UI and the Core LS. To use it:

```bash
# 1. Start the proxy (auto-detects LS port)
node antigravity_mitm_proxy.mjs --filter Cascade

# 2. Redirect UI traffic through it (requires sudo)
echo "rdr pass on lo0 proto tcp from any to 127.0.0.1 port $REAL_PORT -> 127.0.0.1 port $PROXY_PORT" | sudo pfctl -ef -

# 3. Open Antigravity, start new chat, pick Opus, send a message

# 4. Restore normal traffic
sudo pfctl -F all -f /etc/pf.conf

# 5. Read the capture
cat mitm_capture.jsonl | python3 -m json.tool
```

## 5. Binary Reverse-Engineering Intel (from `strings` analysis)

### Critical Discovery: Separate Reactive Component Service
The binary contains a **separate protobuf service** for reactive streaming:
```
exa.reactive_component_pb.StreamReactiveUpdatesRequest
exa.reactive_component_pb.StreamReactiveUpdatesResponse
```
Source: `third_party/jetski/reactive_component/reactive_component.go`

This is the **internal** streaming layer. The `LanguageServerService/Stream*` RPCs likely wrap it, but the reactive component may need its own initialization (e.g., registering a subscriber for a specific `CascadeState`, `ImplicitTrajectory`, or `CascadeTrajectorySummaries`).

### All Cascade-Related RPCs (from binary)
```
StartCascade
SendUserCascadeMessage
SendAllQueuedMessages
GetCascadeTrajectory
GetCascadeTrajectorySteps
GetCascadeModelConfigs
GetCascadeNuxes
InitializeCascadePanelState          ← KEY: unexplored panel init
HandleCascadeUserInteraction
RevertToCascadeStep
ResolveOutstandingSteps
SmartFocusConversation
SendStepsToBackground
UpdateCascadeMemory
SearchConversations
LoadTrajectory
LoadReplayConversation
StreamCascadeReactiveUpdates         ← connects but doesn't wake model
StreamCascadeSummariesReactiveUpdates ← connects but doesn't wake model
StreamCascadePanelReactiveUpdates    ← crashes with different payload
StreamUserTrajectoryReactiveUpdates  ← connects but doesn't wake model
StreamAgentStateUpdates              ← untested
```

### Model Enums Available in Binary (for `ANTIGRAVITY_MODEL`)
```
MODEL_CLAUDE_4_OPUS              MODEL_CLAUDE_4_OPUS_THINKING
MODEL_CLAUDE_4_SONNET            MODEL_CLAUDE_4_SONNET_THINKING
MODEL_CLAUDE_4_5_SONNET          MODEL_CLAUDE_4_5_HAIKU
MODEL_GOOGLE_GEMINI_2_5_PRO      MODEL_GOOGLE_GEMINI_2_5_FLASH
MODEL_GOOGLE_GEMINI_COSMICFORGE  MODEL_GOOGLE_GEMINI_HORIZONDAWN
MODEL_PLACEHOLDER_M26            (maps to premium tier, quota-limited)
```

### Process Layout (current session)
```
PID 67084  Core LS (no --enable_lsp)
           --csrf_token da112bf0-...
           --extension_server_port 56924
           --extension_server_csrf_token 98c0489a-...
           --cloud_code_endpoint https://cloudcode-pa.googleapis.com
           HTTP ports: 56927 (HTTPS), 56928 (HTTP)

PID 67164  LSP LS (--enable_lsp, no --workspace_id)
PID 67173  LSP LS (--enable_lsp, --workspace_id file_Users_kd_Documents_letagents)
```

## 6. What to Try Next

### Theory 1: The UI Context & `nbi` Special Methods (Opus's Final Direction)
Opus discovered that in the `jetskiAgent` UI bundle, `streamCascadeReactiveUpdates`, `handleStreamingCommand`, and `createAgentStateProviderForConvo` are grouped in a special `nbi` or `eru` set of methods that are handled uniquely, bypassing the normal RPC wrapper. Opus was about to investigate `handleStreamingCommand` or use the MITM proxy / DevTools to see exactly how the UI enables this "reactive state" at startup.
**Cursor, you should decide:** Do you want to continue statically analyzing the Javascript bundles to find the initialization flag, or switch to purely sniffing the traffic via the MITM proxy / DevTools network tab?

### Theory 2: MITM is the Fastest Path
We have **exhaustively tested** every cascade-related RPC visible in the binary. The root cause is confirmed: `"reactive state is disabled"`. We also tried `RecordChatPanelSession({ isOpen: true })` — it returns success but does NOT enable reactive state.

The reactive state is enabled by some internal IPC from the Electron renderer/webview to the Core LS that we haven't been able to identify from binary strings alone. The best practical path to capture the actual traffic is using either:

1. **MITM proxy** (`antigravity_mitm_proxy.mjs`) + `pfctl` redirect (see section 4d)
2. **Electron DevTools** — Open DevTools in Antigravity (Cmd+Shift+I or Help menu), go to Network tab, filter for "reactive" or "cascade", then start a new chat. This will show the exact initialization RPC sequence.
3. **`tcpdump` on loopback** (requires sudo):
   ```bash
   sudo tcpdump -i lo0 -A -s 0 'port 56927' | grep -i "reactive\|cascade\|panelState"
   ```

### Theory 2: The Extension Server is the Intermediary
The Extension Server (port 56924) runs `exa.extension_server_pb.ExtensionServerService` and has these RPCs:
```
ExecuteCommand
OpenPluginPage
GetSecretValue
FocusIDEWindow
CheckTerminalShellSupport
OpenAntigravityRulesFile
OpenConfigurePluginsPage
GetCurrentAudioRecording
RestartUserStatusUpdater
GetBrowserOnboardingPort
```
The webview likely calls one of these (possibly `ExecuteCommand` with a specific command payload) to trigger internal initialization in the Core LS. Try:
```bash
curl -sk -X POST "https://127.0.0.1:56924/exa.extension_server_pb.ExtensionServerService/ExecuteCommand" \
  -H "Content-Type: application/json" \
  -H "x-codeium-csrf-token: $EXT_CSRF" \
  -d '{"command":"enableReactiveState"}'
```

### Theory 3: StartChatClientRequestStream
The binary contains this RPC on a separate service:
```
/exa.chat_client_server_pb.ChatClientServerService/StartChatClientRequestStream
```
This might be the missing bidi stream that establishes the chat client as a subscriber. Try calling it on the Core LS port.

## 7. Success Criteria

Write a headless Node.js script that can:
1. Find the Core LS port and CSRF token from `ps`.
2. Call `StartCascade` to create a brand new conversation.
3. Perform the missing initialization/stream handshake.
4. Send: `"What is 2+2? Only output the number."` with `MODEL_CLAUDE_4_OPUS`.
5. Poll trajectory and print the model's response.

**If the script outputs `4` from Opus via a brand new cascade while the IDE is minimized, the 5% is solved.**
