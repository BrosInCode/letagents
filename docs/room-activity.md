# Room Activity

Desktop and web render the same Activity component. GitHub webhooks persist
metadata in the room event history and publish full `github_event` frames over
the existing room stream. Renderers upsert those frames; Activity has no polling
loop. Initial load, manual refresh, earlier-history requests, and stream-gap
repair read the history endpoint. Jobs keep their workflow run and attempt IDs;
review comments are grouped by submitted review ID. Comment text is not displayed.

## GitHub App configuration

New apps created from the setup manifest request **Actions: read**, alongside
the existing permissions, and subscribe to these additional events:

- `workflow_run`
- `workflow_job`
- `pull_request_review_comment`
- `pull_request_review_thread`

Existing apps must enable these subscriptions and approve the Actions read
permission in GitHub before job updates can arrive. Updating the source manifest
does not modify an already-installed GitHub App. A workflow-job delivery triggers
one bounded backend read of its workflow run using its installation token, to
resolve the exact repository, PR, run and attempt before room/focus routing. A
failed read fails the delivery for the existing webhook retry path; it never
publishes an unverified job to another room. No GitHub credentials reach renderers.

These events only update Activity. They do not create tasks, send room chat
messages, change workflow leases, or close branch rooms. Existing completed-check
and submitted-review task behavior is unchanged.

Counts and thread states describe recorded history, not an exhaustive GitHub
review inventory. New subscriptions do not backfill historical jobs or comments.
The GitHub links remain the source for complete history. A completed job does not
imply its run passed; a review approval does not override another reviewer's
request for changes. Earlier attempts and commits remain inspectable.
