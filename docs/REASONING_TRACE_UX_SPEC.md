# Reasoning Trace UX Spec

Status: Draft from overnight room work on 2026-04-21

This document defines the low-noise UX for showing an agent's visible thought
process in-room without exposing raw chain-of-thought or turning chat into a
telemetry stream.

## Product Promise

Let a human see what an agent is trying to do, what it is checking, what it
plans to do next, and when it is blocked, without making the main transcript
hard to read.

The product promise is not "dump every intermediate thought." The product
promise is "show the useful visible decision trace."

## Goals

- make current agent intent legible at a glance
- keep the main chat readable
- support replace-in-place live updates
- preserve durable milestones without persisting every transient thought
- give humans a consistent structure across agents and IDEs

## Non-Goals

- raw token-by-token chain-of-thought dumps
- full tool-call logs in the main transcript
- a second chat stream with every micro-update
- forcing every agent to write a long structured memo on each turn

## Canonical Information Model

The live trace is one structured object per agent per room:

- `summary`: required short current state
- `goal`: what the agent is trying to achieve
- `hypothesis`: current working theory
- `checking`: what the agent is verifying right now
- `next_action`: immediate next step
- `blocker`: current blocker, if any
- `confidence`: optional 0-1 confidence hint

Display-only metadata is derived from the trace plus presence:

- phase: `idle`, `working`, `reviewing`, `blocked`, or `note`
- phase label
- last updated timestamp
- optional compact detail lines

## Surface Rules

### 1. Chat

Chat gets the compact, glanceable version.

- agent reasoning updates render as a compact thinking card
- the chat card should show one summary line plus at most two structured fields
- chat is the collapsed/default view; v1 does not need nested accordions here
- durable milestone messages still live in chat history
- non-milestone reasoning updates should prefer replace-in-place presence state
  over new transcript lines

### 2. Activity

Activity gets the fuller operator view.

- selected agent shows one live "Reasoning snapshot"
- selected agent also shows a short recent "Reasoning trail"
- trail should stay small, newest-first, and easy to scan
- Activity is the place for more detail; chat stays terse

### 3. Presence

Presence is the rewrite channel.

- one active `reasoning_trace` per agent per room
- new live updates overwrite the previous active trace
- identical or near-identical updates should be deduped before they become
  visible churn

## Persisted vs Rewritten

### Rewrite In Place

These should normally overwrite the current live trace:

- "checking the upload route"
- "rebasing onto staging"
- "running tests"
- "still verifying the fix"

### Persist Durably

These should become normal room history messages:

- milestone summaries
- user-visible completions
- meaningful blocker announcements
- handoff points
- review outcomes

Rule: if the update matters later as a project event, persist it. If it only
explains what the agent is doing right now, rewrite it in place.

## V1 Interaction Model

- chat cards are always visible inline when present
- Activity shows the richer snapshot and recent trail
- no separate "thinking tab" in v1
- no hidden expansion to raw internal reasoning
- if an agent provides only a plain status string, the UI should still derive a
  reasonable compact card

## Copy Rules

- summary first, structure second
- prefer plain operational language over self-referential narration
- avoid greetings, acknowledgements, and filler in reasoning traces
- keep summaries short enough to scan in one line
- use milestone messages for "what changed," not for "still thinking"

## Example

Live trace:

- `summary`: `validating the attachment revoke race`
- `goal`: `make staged upload attach and revoke atomic`
- `checking`: `message create transaction ordering`
- `next_action`: `move the claim into one update-returning step`
- `blocker`: `none`

Chat card:

- phase chip: `Working`
- summary: `validating the attachment revoke race`
- fields: `Goal`, `Next`

Activity snapshot:

- summary plus `Goal`, `Checking`, `Next`
- recent trail of the last few meaningful reasoning updates

## Guardrails

- never claim to show "raw thought process" when the product only shows a
  curated visible trace
- do not persist sensitive scratch reasoning by default
- do not emit a new durable message for every live trace refresh
- clear or downgrade stale traces when the agent returns to idle or completes
  the task

## Acceptance Criteria

The reasoning trace UX is correct when:

- a human can tell what an agent is doing without reading a wall of status lines
- chat stays readable during multi-agent work
- Activity gives enough detail for supervision without becoming another log dump
- milestones remain durable and searchable
- live reasoning updates can be overwritten safely and cheaply
