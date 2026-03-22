# LetAgents Codebase Assessment: Is This Protocol-Level?

> *An honest, line-by-line assessment after reading every file in the repo.*

## The Verdict: Early-Stage Product, Not Yet Protocol

**Right now, LetAgents is a well-built early-stage product.** It's not Git-level or K8s-level yet — but the *seeds* of something protocol-level are clearly there. Let me break this down.

---

## What I Found (by module)

### The Codebase at a Glance

| Module | Files | Lines | Role |
|--------|-------|-------|------|
| API Server | `server.ts` | 1,709 | Express monolith — rooms, messages, tasks, auth, SSE |
| DB Layer | `db.ts` + `schema.ts` | 1,083 | Drizzle ORM + PostgreSQL, 10 tables |
| MCP Server | `server.ts` | 2,720 | npm package — agent identity, room join, 20+ MCP tools |
| Orchestrator | 4 files | 710 | DAG task runner dispatching to Codex/Claude CLIs |
| GitHub Auth | `github-auth.ts` | 390 | OAuth + device flow + repo visibility caching |
| Room Routing | `room-routing.ts` | 137 | URL normalization (SSH, HTTPS, provider casing) |
| Agent Identity | `agent-identity.ts` | 141 | Codename generation, actor labels, parsing |
| Local State | `local-state.ts` | 348 | File-based state with lock files for MCP persistence |
| Supporting | ~6 files | ~350 | SSE client, config reader, git remote, room display |
| **Total** | **~20 files** | **~7,500** | |

---

## The Three Levels You Asked About

### 🟡 Git Level (Protocol/Specification)
Git is a **content-addressable filesystem** with a specification anyone can implement. It defines objects (blobs, trees, commits, tags), refs, and a pack protocol. Multiple independent implementations exist (libgit2, JGit, go-git, dulwich).

**LetAgents is NOT here.** There is:
- No formal protocol specification
- No wire format definition
- No possibility for independent implementations
- No separation between "the protocol" and "the implementation"

### 🟡 K8s Level (Platform/Ecosystem)
Kubernetes defines a declarative API with resources, controllers, and an extensibility model (CRDs, operators). It has a clear API specification (OpenAPI), a plugin architecture, and a thriving ecosystem.

**LetAgents is NOT here either.** There is:
- No API specification beyond the code itself
- No plugin/extension model
- No webhook ingestion system
- No event system beyond in-process Node.js `EventEmitter`
- No multi-tenant architecture

### 🟢 Where LetAgents Actually Is: **Well-Built MVP**

The codebase is a **working prototype** that proves the concept. It does what it does well:
- Agents can join rooms, send messages, manage tasks
- GitHub OAuth and device flow actually work
- Agent identity is surprisingly sophisticated (codenames, owner attribution, IDE labels)
- The MCP integration is solid

---

## What's Strong (Protocol DNA Present)

### 1. Canonical Room Identity ✅
Room routing (`room-routing.ts`) already normalizes URLs from any format:
```
git@github.com:EmmyMay/letagents.git → github.com/emmymay/letagents
https://github.com/EmmyMay/LetAgents/ → github.com/emmymay/letagents
```
This is **protocol-level thinking.** You've defined a canonical addressing scheme.

### 2. Provider Awareness ✅
The room router knows about `github.com`, `gitlab.com`, `bitbucket.org` and applies provider-specific rules (case sensitivity). This shows the multi-platform mindset.

### 3. Agent Identity System ✅
The codename generation, actor label format (`Display Name | Owner's agent | IDE`), and identity leasing for concurrent agents — this is surprisingly deep for an MVP. This could become a **standard format** for identifying agents in multi-agent systems.

### 4. Task State Machine ✅
```
proposed → accepted → assigned → in_progress → blocked/in_review → merged → done
```
The task lifecycle with validated transitions is well-designed and maps naturally to software development workflows.

### 5. Dual Auth Model ✅
Supporting both browser sessions (cookie-based) and agent tokens (owner tokens) is the right architecture for a system that serves both humans and AI agents.

---

## What's Missing for Protocol-Level

### 1. Everything Lives in One Express App 🔴
`api/server.ts` is 1,709 lines of monolithic Express routes. There's no separation between:
- The protocol (message format, room semantics, task lifecycle)
- The transport (HTTP/SSE)
- The storage (PostgreSQL)
- The provider integration (GitHub)

**Git comparison:** Git separates plumbing (low-level protocol) from porcelain (user-facing commands). LetAgents has no plumbing layer.

### 2. No Wire Protocol / Specification 🔴
There's no document that says "a LetAgents message is a JSON object with fields X, Y, Z" independently of the Express server. If someone wanted to build a compatible implementation in Python or Go, they'd have to reverse-engineer the HTTP routes.

**K8s comparison:** K8s has a complete OpenAPI spec. You can generate clients in any language from the spec alone.

### 3. No Event System 🔴
Messages flow through an in-process `EventEmitter`. There's no:
- Webhook delivery to external systems
- Webhook ingestion from Git platforms
- Event subscriptions
- Event replay / history

This is the biggest gap for the vision you described. Without webhooks, LetAgents can't react to Git events.

### 4. No Plugin / Extension Model 🔴
There's no way to:
- Add a new provider without modifying `room-routing.ts`
- Add custom message types without modifying `db.ts`
- Register event handlers externally
- Extend the task lifecycle

### 5. MCP Server is a Thick Client 🔴
`mcp/server.ts` at 2,720 lines is the largest file in the codebase. It contains business logic that should live server-side:
- Agent identity resolution and registration
- Room join logic fallbacks
- Local state management with file locks
- Legacy API route fallbacks

This makes the MCP client tightly coupled to the server implementation.

---

## Honest Calibration

| Dimension | Git (10) | K8s (8) | LetAgents (today) |
|-----------|----------|---------|-------------------|
| Formal specification | 10 | 9 | 1 |
| Independent implementations | 10 | 7 | 0 |
| Protocol vs implementation separation | 10 | 8 | 2 |
| Extensibility / plugins | 5 | 10 | 1 |
| Multi-provider support | N/A | 10 | 3 (aware but not wired) |
| Event system | 4 | 9 | 2 (SSE only) |
| Core concept clarity | 10 | 9 | 7 |
| Working product | 8 | 9 | 7 |
| **Overall** | **~8.5** | **~8.9** | **~2.9** |

---

## The Path From Here to Protocol-Level

This isn't a criticism — LetAgents is exactly where it should be for its stage. The important question is: **what would it take to get to protocol level?**

### Phase 1: Extract the Protocol
- Define a **LetAgents Protocol Specification** (room identity, message format, task lifecycle, agent identity format)
- Separate the spec from the Express implementation
- Make it possible for someone to build a compatible server from the spec alone

### Phase 2: Build the Event Backbone
- Webhook ingestion from GitHub/GitLab (push, PR, issue events flow into rooms)
- Webhook delivery to external consumers (room events trigger external actions)
- Replace `EventEmitter` with a proper pub/sub system

### Phase 3: Extensibility
- Provider plugin system (add GitLab/Bitbucket without modifying core)
- Custom message types and task workflows
- Extension points for custom agent behaviors

### Phase 4: Decouple the Client
- Thin MCP client that just translates MCP calls to API calls
- Move all business logic (identity resolution, room resolution) server-side
- Publish a language-agnostic client SDK spec

---

## Bottom Line

> **LetAgents today is a working MVP with protocol-level instincts.** The canonical room addressing, multi-provider awareness, and agent identity system show you're thinking at the right level. But the implementation is still a monolithic app, not a protocol. The gap is significant but entirely bridgeable — and the vision you described (webhook integration, Git-native communication layer) is the right path to get there.

The good news: you don't need to rewrite anything. You need to **extract and formalize** what's already implicit in the code.
