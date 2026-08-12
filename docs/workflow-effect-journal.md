# Workflow effect journal

LetAgents brokers review verdicts submitted through the `submit_review_verdict` MCP tool. A submission reserves one durable `workflow_effects` row under the caller's exact active review lease before contacting GitHub. The room-scoped idempotency key and provider correlation marker identify the logical effect across retries and process crashes.

Every verdict requires the exact 40-hex `expected_head_sha` that the reviewer validated. That SHA is part of the journal fingerprint. Before creating the review, the provider rejects a current-head mismatch without posting; the Create Review request also sends the same SHA as GitHub's `commit_id`, which remains the authority fence if the pull request changes after the preflight check.

The broker uses four states:

- `pending`: one worker owns the provider attempt. A stale pending row is converted to `ambiguous` before reconciliation.
- `succeeded`: GitHub returned a review id, or reconciliation found both the correlation marker and the persisted expected commit SHA on the same review.
- `failed`: GitHub definitely rejected the write. Only this state receives bounded create retries.
- `ambiguous`: the write may have committed. Reconciliation performs provider lookup only; a missing marker or a marker attached to another commit remains ambiguous and is never blindly recreated. Each unsuccessful lookup persists a five-minute `next_attempt_at`, so the normal sweep cannot hammer the provider on every tick. GitHub lookup follows its `Link: rel="last"` pagination metadata and scans a bounded recent-page window where a newly created review marker must appear.

`request_changes` submissions with an empty or obvious junk explanation are persisted as quarantined pending rows. They do not call GitHub and require human handling.

## Boundary and resume rule

Only writes made through a brokered server tool are covered by the effect journal. In P3a, that is `submit_review_verdict`. Direct `git`, `gh`, provider CLI, shell, desktop, and ordinary API writes are still at-least-once operations. After a worker restart or an uncertain command result, the worker must inspect provider reality (for example the current PR reviews, comments, branches, or checks) before repeating an unbrokered write. A local timeout or missing acknowledgement is not proof that the external write failed.

Future non-idempotent task-linked GitHub tools should reserve the same journal before their provider call, embed the `correlation_key` in the created artifact, and add a provider-specific lookup path before they are described as brokered.

Settled rows have a bounded 30-day retention window. The periodic reconciliation pass prunes at most 200 old `succeeded`, quarantined, or retry-exhausted `failed` rows per tick. After a settled row is pruned, that idempotency key no longer has journal-backed replay protection and a later submission may create a new provider effect. Active `pending` and `ambiguous` evidence is retained for reconciliation; the schedule and retention indexes keep both scans bounded.
