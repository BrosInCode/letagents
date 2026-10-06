# Message search inside a room

Web and desktop search the current cloud room's history. The existing find on
loaded messages remains available (including in local desktop rooms); it can also
match sender and attachment names. Server search matches message body text and
`display_text`, so its results need not equal the loaded-message find count.

## HTTP contract

`GET /rooms/:room/messages/search?q=needle&before=msg_40&limit=30`

Encode the whole room identifier as a path component. The route resolves the
canonical room and applies the same participant/repository access check as room
history, before parsing the search or querying messages. Existing sign-in/access
and missing-room responses apply. The endpoint adds no MCP search tool and no
agent-session bearer capability. Agents still read messages with existing tools.

- Trim the query; maximum 200 UTF-16 code units. Require at least two code units
  across its distinct terms (so `a b` is valid; `a a` is too short).
- Up to six distinct words or double-quoted phrases, deduplicated ignoring case.
  Whitespace inside phrases collapses to a space. An unclosed quote runs to the
  end. There are no Boolean operators or quote-escape syntax.
- Every term must occur in `text` or `display_text`. Each may match a different
  copy. The query uses case-insensitive PostgreSQL `ILIKE` substring matching.
  `%`, `_` and backslash are literal characters, not wildcards; values are bound
  parameters. Case folding follows the database locale and can differ from the
  JavaScript client highlighter for non-ASCII text.
- Results are newest first. `before` must be a positive PostgreSQL integer message
  id (`msg_<n>`); it is exclusive and scoped to this room. The id need not exist.
- Default page size 30, maximum 50. The route parses decimal `limit`; absent,
  unreadable or nonpositive values use the default, larger values clamp to 50.
- The normal visible-history predicate applies, plus a search-only exclusion
  for `auto` prompts whose text is blank under the full JavaScript whitespace
  set, even if `display_text` matches. Shared history visibility stays unchanged
  so it remains consistent with the materialized thread-summary triggers. Thread replies are included
  and retain their thread ids. Attachment names/bodies are not searched.

The response is `{ room_id, terms, messages, has_more, next_before }`. `messages`
uses existing hydrated room messages, including identity, reply and thread
metadata. When `has_more` is true, pass `next_before` unchanged for the next page;
otherwise it is null. There is no cross-room search or new index.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `query_too_short` | Fewer than two effective term characters |
| 400 | `query_too_long` | More than 200 trimmed query characters |
| 400 | `query_too_many_terms` | More than six distinct terms |
| 400 | none | Invalid `before` value |
| 503 | `search_timeout` | PostgreSQL cancelled a statement after four seconds |
| 500 | none | Opaque JSON error; database/access-resolution details are not returned |

The search and hydration run inside a transaction with `SET LOCAL
statement_timeout = '4s'`. This bounds each statement, including lock waits; it
is not a four-second whole-request deadline. Leading-wildcard searches can scan
all messages in a room. Cancellation rolls back and does not change the timeout
of a later request using that pooled connection.

## Results and revealing messages

Typing is debounced for 250 ms. Changing the query or room, clearing the room,
closing desktop search, or disposing the view invalidates old answers. A failed
later page retains results and permits retry with Show more.

Snippets and expanded text use escaped text nodes, with `<mark>` around matching
runs. Expansion reads the returned message, without fetching history. Show in
room reuses the existing reveal path, including desktop thread opening. Search
keeps the existing five-page reveal bound: a result beyond it remains readable
by expanding it, and the existing unavailable notice appears. This task does not
change permalink/reveal bounds.

## Repeatable local verification seed

Use a disposable PostgreSQL database you own. From the repository root, set
`DB_URL` to it, run `npm run db:migrate`, then run this exact seed. It creates a
new ad-hoc room and refuses to append to an existing nonempty fixture. Use a new
`SEARCH_QA_ROOM` value to repeat without deleting data.

```sh
SEARCH_QA_ROOM=message-search-qa node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createProjectWithName, addMessage, getMessages } from './src/api/db.js';
import { searchRoomMessages } from './src/api/db/messages/search.ts';
import { pool } from './src/api/db/client.ts';
try {
  const room = await createProjectWithName(process.env.SEARCH_QA_ROOM);
  assert.equal((await getMessages(room.id)).messages.length, 0, 'Use a new fixture room name');
  const far = await addMessage(room.id, 'Seed', 'far-back-needle: readable by expanding the result', { source: 'browser' });
  let unloaded;
  for (let i = 1; i <= 1500; i++) {
    const message = await addMessage(room.id, 'Seed', i === 1200 ? 'unloaded-needle: page back to this' : `filler ${i}`, { source: 'browser' });
    if (i === 1200) unloaded = message.id;
  }
  for (let i = 1; i <= 45; i++) {
    await addMessage(room.id, 'Ada', `batchneedle ${i}: lock timeout, coverage 100%, a_b, C:\\temp. ${'context '.repeat(40)}`, { source: 'browser' });
  }
  const recent = await addMessage(room.id, 'Ada', 'İstanbul mint! banana! <img src=x onerror=alert(1)>', { source: 'browser' });
  const root = await addMessage(room.id, 'Ada', 'A search thread', { source: 'browser' });
  const reply = await addMessage(room.id, 'Grace', 'threadneedle reply', { source: 'browser', thread_root_message_id: root.id });
  await addMessage(room.id, 'Agent', '\t\n', { source: 'agent', agent_prompt_kind: 'auto', display_text: 'hiddenneedle' });
  const first = await searchRoomMessages(room.id, ['batchneedle']);
  assert.equal(first.messages.length, 30);
  const second = await searchRoomMessages(room.id, ['batchneedle'], { before: Number(first.next_before.slice(4)) });
  assert.equal(second.messages.length, 15);
  assert.equal((await searchRoomMessages(room.id, ['hiddenneedle'])).messages.length, 0);
  assert.equal((await searchRoomMessages(room.id, ['100%'])).messages.length, 30);
  assert.equal((await searchRoomMessages(room.id, ['far-back-needle'])).messages[0].id, far.id);
  assert.equal((await searchRoomMessages(room.id, ['unloaded-needle'])).messages[0].id, unloaded);
  assert.equal((await searchRoomMessages(room.id, ['threadneedle'])).messages[0].thread_root_id, root.id);
  console.log(JSON.stringify({ room: room.id, far: far.id, unloaded, recent: recent.id, root: root.id, reply: reply.id, pages: [first.messages.length, second.messages.length] }, null, 2));
} finally { await pool.end(); }
JS
```

Start your local API against that database and the web dev server using the
repository's existing setup (`npm run dev:api`, `npm --prefix src/web run dev`).
The web dev proxy expects the local API on port 3001. Do not replace an API owned
by another session. Open `/in/message-search-qa` on the web dev origin (or the
room printed for a different seed name). No additional Electron instance is
needed for web verification.

Browser checklist for the reviewer (not covered by shell, SSR or unit tests):

1. Search `batchneedle`: 30 results and Show more; press it for 45 unique results.
   Expand a long result, collapse it, and verify readable highlighted text.
2. Search `"lock timeout" 100%`, `a_b`, and `C:\temp`: literal phrase/wildcard
   handling. Search `mint`: only `mint` is marked after `İstanbul`; `ana` highlights
   the entire overlapping `anana`. The image tag stays text and never executes.
3. Show `mint` in room: scroll/highlight the recent message. On a fresh room load,
   show `unloaded-needle`: older history loads, then scrolls/highlights it.
4. Reload first, search `far-back-needle`, then Show in room: the five-page bound
   produces the unavailable notice; expansion still shows its full text.
5. Search `threadneedle`: reveal the reply (desktop opens its thread). Search
   `hiddenneedle`: no result. Check keyboard focus and scrolling at narrow widths.
6. Change rooms while a search is pending, then clear/close search: old results
   never populate the new room. A private room still requires normal access.

Automated tests live in the three `src/api/__tests__/message-search-*.test.ts`
files, desktop search/IPC and renderer tests, and `src/web/tests/room-history-search.test.ts`
plus `message-search-results-component.test.ts`. The database suite uses
`TEST_DB_URL` and exercises a real four-second lock timeout. Live browser checks
remain a separate review step.
