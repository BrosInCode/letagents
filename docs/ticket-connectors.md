## Connections and providers

An account connects Jira or Linear once, in the desktop app under
**Settings → Ticket trackers**. The server can then read that person's tickets
and, through the workflow effect journal, move tickets and add comments.

### Connect a tracker

1. Open **Settings → Ticket trackers**.
2. Choose **Add Jira** or **Add Linear**.
3. Choose **Sign in with Jira** (or Linear) to approve access in the browser.
   The app waits; when you approve, the browser returns to the app on this
   computer and the app finishes the connection. Or enter an API token:
   - Jira: the site (`https://your-team.atlassian.net`), the Atlassian account
     email, and an API token from <https://id.atlassian.com/manage-profile/security/api-tokens>.
   - Linear: a personal API key from Linear's **Settings → Security & access**.
4. Choose **Test connection**. The app lists up to five open tickets that are
   assigned to you, with the board column each status maps to.

The server checks the credentials with the tracker before it stores them.
Connecting the same Jira site or Linear workspace again replaces the stored
credentials of that connection (use this to reconnect). **Remove** deletes the
connection and its credentials.

### Status map

Every tracker status maps to one of four ticket states: `todo`, `in_progress`,
`in_review`, `done`. The defaults are:

| Tracker | Default map |
|---|---|
| Jira | To Do → todo, In Progress → in_progress, In Review and Code Review → in_review, Done and Closed → done |
| Linear | by state type: triage, backlog, unstarted → todo; started → in_progress; completed and canceled → done. The name "In Review" → in_review. |

A status name entry wins over a Linear type entry. Names are not case sensitive.
A status with no entry shows as `in_progress`. The connection remembers it as
unmapped, and the settings page asks you to choose its column. Edit the map in
**Status map** and choose **Save status map**.

### Jev linking

Each connection has a **Link pull requests with Jev** switch. It is off by
default. When it is on, a later part of this feature asks Jev to link a pull
request that names no ticket. For each such pull request, its title, a shortened
description, commit subjects, and the keys and titles of up to 20 open tickets
from the connection are sent to Jev's model provider. Jev only suggests a link;
it never changes a ticket by itself.

### Tracker writes go through the journal

Every Jira or Linear write is a `workflow_effects` row of kind
`tracker_transition` or `tracker_comment` (see
[workflow-effect-journal.md](workflow-effect-journal.md)). The broker reserves
the row with an idempotency key before it calls the tracker. The caller names
the connection and the account it resolved it from; the journal refuses a
connection that belongs to another account. A caller must take the connection
from the room's own configuration, never from agent input.

- A transition names its target status. The server reads the issue's available
  transitions at run time and uses the one that reaches that status. An issue
  already in the target status is not changed, and the effect succeeds.
- A Jira comment carries the effect's correlation key in a hidden comment
  property (`letagents.effect`). A Linear comment is created with an id derived
  from the correlation key.
- After an uncertain result, reconciliation only looks: it finds the comment by
  its marker, or a transition in the Jira changelog or Linear issue history that
  reached the target status after the effect started. It never writes again.

### Server setup

| Variable | Required | Meaning |
|---|---|---|
| `LETAGENTS_CONNECTOR_SECRET_KEY` | yes | 32 random bytes, as 64 hex characters or base64. Encrypts stored credentials (AES-256-GCM). Without a valid key every connector route answers 503 and tracker effects fail without a write. |
| `LETAGENTS_JIRA_CLIENT_ID`, `LETAGENTS_JIRA_CLIENT_SECRET` | no | An Atlassian OAuth 2.0 (3LO) app. Without them, Jira connects with API tokens only. |
| `LETAGENTS_LINEAR_CLIENT_ID`, `LETAGENTS_LINEAR_CLIENT_SECRET` | no | A Linear OAuth app. Without them, Linear connects with API keys only. |
| `LETAGENTS_JIRA_ALLOWED_HOSTS` | no | Extra Jira host names (comma separated) for a site that is not on `atlassian.net`. |

Make a key with `openssl rand -hex 32`. The OAuth callback URLs are
`${LETAGENTS_BASE_URL}/account/connectors/oauth/jira/callback` and
`${LETAGENTS_BASE_URL}/account/connectors/oauth/linear/callback`. The Jira app
needs the scopes `read:jira-work write:jira-work read:jira-user offline_access`;
the Linear app needs `read,write`.

Key rotation is not supported yet. A new key makes stored credentials
unreadable: each connection then shows **Reconnect**, and the person connects
the tracker again.

### Security notes

- Credentials are encrypted at rest. The ciphertext is bound to its connection
  and account, so it cannot be copied to another row. API responses, logs and
  journal rows never contain them; tracker error text is scrubbed.
- Requests with a person's credentials go only to `api.atlassian.com`, a Jira
  Cloud site on `*.atlassian.net` (or an allowed host), or `api.linear.app`, over
  HTTPS, without following redirects.
- OAuth finishes only in the app that started it. The app listens on a random
  port on `127.0.0.1` and sends it with the start request. The tracker sends the
  browser to the server's callback, which connects nothing: it forwards the
  code to that port on the browser's own computer. The app then calls
  `/complete` with its own session, and the server requires that the account
  that started the sign-in is the account that finishes it. A sign-in link
  forwarded to another person delivers the code to their computer, where no app
  waits for it, so nobody can link someone else's tracker to their account.
- The OAuth `state` is random (256 bits), stored only as a hash, bound to the
  account, the tracker and the loopback port, valid for 10 minutes, and good for
  one attempt.
- Connector routes accept only the desktop app's session sent as a bearer.
  Owner tokens (what MCP agents carry), worker bearers, supervisor grants and
  cookie-only requests are refused, so an agent cannot add or remove a
  connection, read tickets with it, or turn on Jev linking.
- Each account has 10 connection attempts (API token or OAuth start) per 10
  minutes, so the server cannot be used to test stolen credentials.
- A Jira room filter must have balanced parentheses and quotes, so it cannot
  break out of the group it is wrapped in.
- OAuth refresh tokens rotate. A refresh first re-reads the stored credentials,
  saves with a compare-and-set, and on a refused refresh waits briefly for
  credentials another process saved. Two API instances can still both refresh
  in rare timing; the loser then asks the person to reconnect.
- Jira OAuth: one connection per Jira site. If the Atlassian account can reach
  several sites, the first one is connected.

### HTTP routes

All routes except the OAuth callback need the desktop app's session bearer.

| Route | Purpose |
|---|---|
| `GET /account/connectors` | List connections, which sign-in methods the server offers, and the Jev disclosure. |
| `POST /account/connectors/oauth/:provider/start` | Start OAuth (`loopback_port`); returns the URL to open. |
| `GET /account/connectors/oauth/:provider/callback` | The tracker's redirect target; forwards to `http://127.0.0.1:<loopback_port>/tracker-oauth/callback`. |
| `POST /account/connectors/oauth/:provider/complete` | Finish OAuth (`state`, `code`) as the account that started it. |
| `POST /account/connectors/api-token` | Connect with an API token (`provider`, `api_token`; Jira also `site_url`, `email`). |
| `POST /account/connectors/:id/test` | List up to five tickets assigned to you and record unmapped statuses. |
| `PATCH /account/connectors/:id` | Change `display_name`, `status_map` or `jev_linking_enabled`. |
| `DELETE /account/connectors/:id` | Remove the connection. |

### Tests

```bash
node --import tsx --test src/api/__tests__/connector-crypto.test.ts src/api/__tests__/connector-providers.test.ts src/api/__tests__/connector-routes.test.ts src/api/__tests__/tracker-effect-broker.test.ts
TEST_DB_URL=<disposable-test-database> node --import tsx --test --test-concurrency=1 src/api/__tests__/tracker-connections-db.test.ts
```

Provider tests answer from fixtures in `src/api/__tests__/fixtures/connectors`
and fail on any request they do not expect, so CI makes no live tracker call.
