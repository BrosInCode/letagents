# Private human conversations

Messages is a separate account-based conversation surface in the desktop and web apps. A one-to-one chat and a group chat use the same model. Each exact sorted set of account IDs has one conversation. Adding people opens that expanded set, creating it if necessary; the old conversation and its history stay with the original people. Membership is immutable. Current capacity is 100 people including the sender.

The initiator can send one introduction. Each other participant accepts the request before the conversation allows more messages. People can mute, archive, block and unblock. Read cursors are monotonic and shared across devices. Messages are plain text, up to 20,000 characters. Sending retries use a caller-generated ID and return the original message without duplication.

## Credential boundary

An app session represents interactive sign-in. An owner token represents delegated agent access. Room worker and supervisor credentials keep their existing scopes. The API permits private conversation reads, writes, people search and change subscriptions only with an app session. It derives sender identity from that session and verifies membership for every conversation operation. Client headers and body flags confer no human authority.

Web uses the existing HttpOnly session cookie; cookie mutations require the application's origin. Desktop starts a proof-bound browser approval through `/auth/app/start`, opens the returned verification URL, and exchanges its private verifier through `/auth/app/exchange`. The browser must already have an interactive session (or complete GitHub OAuth), compare the displayed code, and submit the consent form. Owner tokens cannot approve it. A successful exchange issues a separate app session and agent token. Only the latter is installed into MCP configuration or used by managed agent requests and rental host operations.

Desktop stores these secrets separately with Electron safeStorage. An unavailable OS credential store fails sign-in; secrets are never written as plaintext. The renderer receives typed conversation methods, not credentials or a general-purpose authenticated fetch method.

This is an API authorization boundary, not end-to-end encryption. The service stores message text. These sessions do not protect against a compromised OS or an agent that independently gains the human's browser or OS credential access.

## Delivery and privacy

Message writes and per-account change versions commit together. PostgreSQL notifications wake subscribers; durable versions and ordered message cursors recover missed changes. Notification payloads contain a generic private-message preview, not message text. Delivery rechecks the target device's app session, block state, mute/archive preferences and read cursor. Private conversation IDs are never room IDs and are not registered with room workers, room event streams, MCP tools or app-agent context.

## Beta rollout

Apply the migration and API before releasing the desktop. Existing agent owner tokens continue to work for their agent capabilities, but desktop headers no longer grant human room privileges. Existing desktop auth files predate the split and require a fresh sign-in. Version 2 of the auth store is intentionally required; old owner tokens are never promoted into app sessions. Signing in refreshes installed MCP configurations with the new agent token.

Ship the API and desktop together on `staging`; publish the desktop version only after the reviewed integration commit passes CI. Reauthentication is the intended beta migration, not a silent compatibility fallback. Normal Git Rooms and their existing history are unchanged by the private conversation tables.

## Verification

`private-conversations-db.test.ts` exercises real PostgreSQL transactions and HTTP authentication: canonical groups under concurrency, isolated history, outsider denial, machine-token denial, request acceptance, idempotent sends, blocking, same-origin cookie writes, browser consent/proof exchange, live versions, forward/backward pagination, and per-device notification eligibility. Desktop auth tests cover separate transport credentials, encrypted storage, cancellation races and logout. Existing room route tests cover the app-session migration without relaxing worker identity requirements.
