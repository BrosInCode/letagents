# Personal desktop message reminders

The message menu offers 20 minutes, 1 hour, 3 hours and tomorrow at 09:00 local.
It sends one absolute timestamp. The server checks database time: strictly
future, no more than 30 days away. Local-only messages cannot create reminders.

The existing Inbox has a Reminders section with pending/due items, Open message
and Cancel/Dismiss. It refreshes on opening, existing refresh/focus paths and
mutations, with no new loop. Empty sections stay hidden except for errors or
loading after a personal action. Scheduling confirms through the existing
transient app toast, outside the message flow. Pages contain 50 entries.
Account changes clear state and reject late responses. Opening passes the message ID to existing
bounded reveal, including thread replies. APNs keeps the existing click target.

Routes require interactive app sessions; agents and owner tokens are refused.
Account IDs come only from the session. Creation requires canonical-room
participant access and a visible message. Lists load previews only after the
ordinary cached session room-access check. Delivery still checks access fresh.
Unavailable access reveals no preview but still permits owner cleanup. Nothing is added to MCP or room streams.

`message_reminders` stores no text. An indexed due-time query claims at most 50
pending reminders in the existing two-second worker tick, atomically marking
them due and creating device deliveries. Even without enabled devices or APNs
credentials, reminders become due in Inbox. This means self-hosted servers now
run the same two-second tick even when APNs is not configured. An account
advisory lock caps pending reminders at 100. Creation/cancellation/due claiming use a three-second lock
timeout; route timeouts return 503. The shared claim function also gives ordinary
message-alert claims that same three-second lock timeout.

`desktop_reminder_deliveries` is unique on (device_id, reminder_id). The ordinary
outbox and its unique index remain unchanged. Migration 0111 is additive and
must follow task_9's 0110. Original alerts and separate reminders have distinct
notification/collapse IDs. Both kinds share claim, authorization, APNs delivery,
result classification, retry policy and device-failure limits.

Reminder previews start blank and are loaded into memory only after access
checks. Current visibility and cancellation are checked on every attempt.
Hidden messages drop the reminder; deletion cascades. Cancel removes delivery
rows, but cannot recall an APNs request already in flight or accepted. Delivery
retains existing at-least-once APNs retry semantics. Atomic enqueue does not
promise exactly-once APNs receipt.

Terminal delivery rows have blank previews and the existing retention windows:
30 days delivered, 90 days dead. Due Inbox entries expire after 30 days (or can
be dismissed sooner), cascading their deliveries. Pending entries are unaffected by retention cleanup.
Reminder enqueue never reads room mute/snooze preferences. No room message,
invalidation, agent wake/delivery, unread or read-receipt change is introduced.

Real Postgres tests cover claims, cap concurrency, time bounds, cancellation,
account/device isolation, access denial, hidden/deleted targets, retries,
retention and coexistence with ordinary alerts. Route/IPC tests protect personal
access and local-room rejection. Renderer tests exercise local DST times,
account races, Inbox presentation and actual submenu handlers.

Live checks remain required: submenu keyboard/focus/position, Inbox pagination,
cancel/dismiss, multiple desktop devices, warm and quit-state notification clicks,
older/thread targets, access revocation and muted-room reminders. Unit/SSR/shell
checks are not browser or native QA. Task_9 must merge first; final journal order
and mute-bypass integration need its actual migration on the required rebase.
