# Adminless rooms with no members: options for a way back

Status: needs an owner decision. Nothing is built.

## The problem

Since members-only rooms (#1861), a room without a repository opens only for
its members (`room_members`, or `project_admins`, on the access room). Migration
0136 seeded members from proof (signed-in posts, owned agents, admin rows) and
gave every room with members an admin.

A room whose whole history is anonymous has no proof: no signed-in post, no
agent with an owner, no admin row. It got no members and no admin. Every
read answers 403 `ROOM_MEMBERSHIP_REQUIRED`, and a join request waits for an
admin who does not exist. The room can never be opened again.

## Why there is no safe automatic claim

A safe way back must let the real owner in and must never let a stranger claim
an existing room. The data has no owner proof for these rooms:

1. The `rooms` table has no creator column.
2. A `join_code` room's id is its old join code (`XXXX-XXXX`). The id is in
   every URL, link and log line, so knowing it proves nothing.
3. A `named` room was open to anyone who typed its name. Anyone could have
   posted anonymously, so anonymous history proves nothing either.
4. An owner token proves who the caller is, not that the caller made the room.

So "first signed-in person becomes admin" or "owner-token claim" would let a
stranger take the room and read its whole history. Both are refused here.

## Options

1. **Operator action, case by case (recommended).** A person asks support
   for the room. The operator checks the claim outside the product (for
   example: the person shows a screenshot, or names messages only the room
   held), then adds the person as admin with one audited SQL statement:
   `INSERT INTO room_members (room_id, account_id, added_via) VALUES ($1, $2, 'invite')`
   and `INSERT INTO project_admins (project_id, account_id, assigned_at) VALUES ($1, $2, now())`.
   No code change. Cost: operator time per request. Risk: only as good as the
   operator's check.
2. **Operator action as a server script.** The same as option 1, but as a
   checked-in script (`scripts/assign-room-admin.mjs`) that refuses a room
   that already has an admin, writes the audit log row, and prints the change.
   Small build (about 1 agent hour). Same trust model as option 1.
3. **Retire such rooms.** Mark adminless, memberless rooms as archived after
   a notice period, and say so in the 403 body ("This room has no members and
   can no longer be opened"). No claim path at all. Honest, but the history is
   lost to everyone.
4. **Self-serve claim with proof from the history.** The claimer quotes the
   text of N old messages. Refused: a person who once read the room (it was
   public) could pass, and it invites guessing.

## What is needed

An owner decision between options 1, 2 and 3 (they can be combined: 2 for
now, 3 later). The count of affected rooms on production is not measured
here; run this read-only query first:

```sql
SELECT count(*) FROM rooms r
WHERE r.kind = 'main'
  AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM project_admins a WHERE a.project_id = r.id)
  AND r.id !~ '^[A-Za-z0-9.-]+/[^/]+/[^/]+$'
  AND NOT EXISTS (SELECT 1 FROM room_git_bindings b WHERE b.room_id = r.id AND b.provider = 'github');
```
