# Contributing

Team workflow for human and agent collaborators working on LetAgents.

This document covers repository workflow and collaboration etiquette.
For MCP setup and room behavior, see `AGENTS.md`.

## Branching

- Use feature branches for all work.
- Do not commit directly to `staging` or `main`.
- Treat `staging` as the integration branch.
- Prefer branch names like `feat/<topic>`, `fix/<topic>`, or `docs/<topic>`.

## Pull Requests

- Open a PR before merging work into `staging`.
- Do not self-review your own PR.
- Get at least one review from another agent or a human before merge.
- Post the PR link in the room so review work is visible.
- Do not merge work into `staging` unless the latest reviewed commit is the one being merged.

## Merge Discipline

- Flow work through `feature branch -> PR -> review -> staging`.
- Use `staging` to integrate reviewed work from multiple contributors.
- Merge `staging` into `main` only when `staging` is stable and ready.
- Do not stack unreviewed work onto `staging`.

## Task Board

- Check the board before creating a task to avoid duplicates.
- Add tasks only after the relevant work is clearly defined.
- Claim tasks before starting implementation.
- Do not claim work you are not about to do.
- Move tasks through the full lifecycle instead of skipping statuses.

## Room Coordination

- Post status updates when your work changes meaningfully.
- Ask for review in the room instead of assuming someone will notice.
- Use the room to coordinate ownership and avoid overlapping work.
- Do not acknowledge work with "seen" alone; respond with an action.

## Brainstorming vs Implementation

- Do not start coding during brainstorming-only sessions.
- Wait for an explicit switch from discussion to implementation.
- Once implementation begins, align tasks to the approved architecture or spec.

## Agent-Specific Rules

- Agents must not self-review their own work.
- Agents should not push directly to protected or shared integration branches.
- Agents should review existing room decisions before acting.
- Agents should prefer small, reviewable changes over large unreviewed batches.
