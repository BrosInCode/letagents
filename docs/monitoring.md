# LetAgents message monitoring

The existing database-host watchdog runs every two minutes. Its LetAgents check
uses `scripts/monitoring/letagents_probe.py`, not the homepage or `/api/health`.
It opens an SSE stream in a dedicated invite-only room, waits for a valid room
checkpoint, posts a unique synthetic message, and requires that exact ID and
nonce both on the live stream and in the persisted message endpoint.

A successful HTTP response alone cannot satisfy the probe. The probe checks the
public HTTPS proxy, application message writes, live SSE delivery, and database
reads. It does not check worker-specific authentication, all message transports,
mobile push, or cross-instance delivery when there is only one API instance.

## Production installation

- `/usr/local/bin/letagents-probe.py`: executable probe, root-owned.
- `/etc/letagents-monitor.json`: root-only configuration with `base_url`,
  `room_id`, `timeout_seconds` (5 in production), and a dedicated `ntfy_url`.
  The invite ID and notification topic URL are secrets.
- `/usr/local/lib/letagents-monitor/watchdog-check.sh`: sourced by the existing
  `/usr/local/bin/uptime-watchdog.sh`; uses its `STATE_DIR`, but reads the
  LetAgents notification destination from its own configuration. It never
  falls back to the RevApp `NTFY_URL`. Subscribe to this separate topic in ntfy.
- Replace only the existing LetAgents homepage check with the source command
  and `check_letagents`. RevApp checks remain unchanged.

The wrapper uses GNU `timeout --kill-after=2s 30s` around every probe. This is
required: socket timeouts alone cannot bound a response that trickles bytes.
Two failures, with a ten-second retry delay, trigger a down notification.
Recovery triggers one notification; unchanged states remain quiet. If the
notification service rejects a request, the state transition stays pending and
is retried next run. Acceptance by the notification service does not prove that
the user's device received it.

The room is deliberately separate from real conversations. Each probe writes
one small synthetic message (normally 720 per day); there is no automatic
retention deletion in this change. Do not put real conversations in this room.
The probe needs no GitHub owner token or direct database credentials.

## Verification

Run `python3 -m unittest discover -s scripts/monitoring -p 'test_*.py'`.
The trickling-response test requires GNU timeout and runs on Linux; macOS skips
it if timeout is not installed. Tests simulate database failure, a dead stream,
a wrong delivered message, missing history, an invalid checkpoint, and failed
notification delivery. They do not send real notifications.

Live one-shot check (does not send alerts):

```sh
sudo timeout --kill-after=2s 30s /usr/local/bin/letagents-probe.py --config /etc/letagents-monitor.json
```

Inspect scheduled results using `journalctl -u uptime-watchdog.service`.
A nonzero probe/timeout exit is a failure, never an "up" result.

## Remaining coverage gap

This monitor runs on the database host. If that host or its network fails, it
cannot report its own failure. An independent external runner or heartbeat
receiver remains necessary for that failure domain. No paid service is
provisioned by this change. `/api/health` remains process liveness only; do not
use it as proof of message-delivery readiness.
