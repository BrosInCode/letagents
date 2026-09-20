# Product language

Write for someone using LetAgents to get work done, without assuming they know how it is built.

## Review rules

- Lead with the outcome, then the next useful action. “Your changes are saved. Restart the agent to apply them.”
- Use familiar words consistently: **agent**, **assignment**, **request**, **connection**, **work history**, **settings**. Keep internal names such as worker, lease, intent, runtime generation, and receipt in code or technical details.
- Use an agent or room name for recognition. Keep the exact identifier for matching, authorization, support, and actions. Never substitute a display name in an API request.
- Reveal technical details when someone needs them. Do not make a UUID, encoded branch, JSON document, or configuration key the main description of an object.
- Explain permissions by what the agent can do. Preserve whether it asks first, can change files, can run commands, and can reach outside the project. “Full access” must not hide those consequences.
- Preserve uncertainty. Disconnected does not mean stopped. Saved settings do not mean applied settings. Incomplete history does not prove that no work happened.
- Error messages say what failed and how to recover. Keep verification and access checks intact. Never offer approval controls for an unverified request.
- Shorten or remove instructions that merely explain the interface. Prefer an obvious label or button to a paragraph about implementation.
- Keep necessary technical language in developer setup instructions and diagnostics. Explain it where introduced; do not replace a precise concept with an inaccurate promise.

## Sources

- [Microsoft: Avoid jargon](https://learn.microsoft.com/en-us/style-guide/word-choice/avoid-jargon) — choose familiar words and consider what the audience understands.
- [Microsoft: Use technical terms carefully](https://learn.microsoft.com/en-us/style-guide/word-choice/use-technical-terms-carefully) — explain necessary terms in context and use terminology consistently.
- [GOV.UK: Writing for user interfaces](https://www.gov.uk/service-manual/design/writing-for-user-interfaces) — write for scanning, put useful information first, and improve the interface when extra explanation is a symptom of confusion.
- [GOV.UK: Error messages](https://design-system.service.gov.uk/components/error-message/) — describe the problem and how the user can fix it.

## Audit coverage

This ledger covers both product-copy audits. Code identifiers, wire formats, permission gates, verification, task ownership rules, and storage behavior are unchanged.

| Finding | Resolution |
| --- | --- |
| Add-agent background lifecycle, local rooms, cloud requirement | Already corrected on staging; preserve existing accurate explanation. |
| Saved configuration revisions and restart action | Explain saved versus applied settings and when to restart. |
| Room-move journals, nonterminal steps, ingress, tail, credentials | Explain move progress and resuming an interrupted move. |
| Stop/correct durable control and uncertain outcome | Explain the pending action, confirmation, and when a new request is allowed. |
| Work history: retained work, receipts, mutating outcomes, causal timeline | Use work history, results, activity, and plain uncertainty messages. |
| Legacy safety transition and missing conversation | Explain why the run stopped, what is unknown, and that it will not replay. |
| Agent settings and duplicate worker-status empty states | Show agents and an Add agent next step. |
| Stale supervisor / provider state | Explain reconnecting, the latest check, and uncertain activity. |
| Update daemon, mutation pause, provider processes | Explain that agents keep running and controls pause while the app restarts. |
| Rental availability, runtime, sandbox, temporary workspace | Use agent apps and file/command access; preserve isolation limits. |
| Renting settings daemon state and host ID | Show connection state and readiness. |
| Rental session UUID and creation banner | Lead with task title; keep a support reference in details. |
| Rental “Exposures” | Use “What the agent accessed.” |
| Host grant IDs and canonical keys | Place required security identifiers in explicit advanced connection setup. |
| Inspector and agent-list room identifiers | Prefer room names and readable branch-room labels. |
| Purge confirmation | Type the agent name; explain permanent history/settings deletion and retained project files. Action identity remains unchanged. |
| Task worker, work lease, execution authority, lane | Use working agent, assignment, permission to work, and transfer. |
| Review authority and self-review conflict | Explain reviewer assignment and require a different agent to review. |
| Reviewer session suffixes / handoff candidates | Remove ID suffixes; distinguish otherwise identical available connections with numbered labels. |
| Rules board operating contract, lease state, routing signals | Explain project workflow, assignments, and what warnings mean. |
| Web activity session liveness, enriched/basic, host metadata | Explain connection updates and additional desktop activity. |
| Desktop promotion heartbeat paragraph | Explain the benefit of running Desktop on the agent’s Mac. |
| Read-receipt “evidence” | Explain read/delivery updates and availability in shared rooms. |
| Permission policies, CLI flags, tool names, bridging, gated | Explain actual access and unavailable choices; preserve mode-specific behavior. |
| Cursor Ask-before-writes warning | Already accurate on staging; preserve the warning that ordinary edits may happen without asking. |
| Cursor preflight exact supervision / MCP authority | Give a readable failure title; keep sanitized diagnostic detail behind disclosure. |
| Approval agent keys and ISO timestamps | Resolve display names by exact identity; display readable expiry times. |
| Approval public reference, canonical JSON, UTF-8 errors | Explain requested changes and recovery; retain exact verified data in technical details. |
| Offline/recovery axis, terminal payload, fenced supervisor | Explain lost connection without claiming termination; retain confirmed stopping plus assignment transfer, or explicit human direction, as conditions for reassignment. |
| Manager replacement, pending intents, config names and tool calls | Explain replacement settings and pending requests. |
| Auto-approval and empty-board notices | Explain proposed tasks and approval requirements. |
| Room history structural outcomes and raw agent keys | Show saved results and agent names. |
| New-room Cloud/shared, Local/private, source, identifier, normalization | Use Shared online and Only on this Mac; remove redundant identifier and normalization instructions. |
| Storage provider-backed repository | Explain connecting to a repository hosted online. |
| Focus key / room ID / activity scope / routing details | Removed upstream with FocusRoomDetailPanel. |
| Focus audit-evidence / close-the-loop instructions | Removed upstream. |
| App Agent typed actions, registry, model slug, Electron storage | Explain the assistant’s model, available actions, and secure key storage. |
| App Agent trace tool path and model retry | Explain retrying an action and stopping before an action. |
| Landing setup, unqualified no-account claim | Explain connecting an agent and distinguish agent access to public/private projects. |
| Room sign-in security narration and raw device-flow commands | Shorten sign-in copy and link the agent setup guide. |
| “One-click” manual configuration | Label it Connection settings. |
| Mobile source-task ID and generic 404 | Companion change against the mobile branch; mobile is not part of staging. |

## Scope and proof

The change is limited to visible copy and presentation across desktop, web, and generated room notices, plus existing expectations and focused regression tests for changed presentation. No API or schema migration, dependency change, permission expansion, task reassignment behavior, or agent execution change is required. Validation is recorded in the pull request, including independent review of its final commit.
