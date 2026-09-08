# Organization onboarding PR stack

Status: draft feature stack. Do not merge into staging or deploy as part of this work.

The person signs in with their own GitHub account. A GitHub organization owner
sets up one company space; verified active members can subsequently join it.
An organization groups repo rooms: a repo remains the room where people work
with agents. Organization membership does not grant repository access.
Personal repositories, shared repositories, and ad-hoc rooms remain usable
without setting up a company. External repo collaborators retain repo access.

Each slice has its own branch and draft PR. Slice 1 targets staging; each later
slice targets the preceding branch so reviews show only that slice's changes.

1. **Data model** (`codex/org-01-data-model`): organization identity keyed by
   GitHub ID and memberships for people who actually join LetAgents. Additive
   migration; company membership is separate from room ancestry and permissions.
2. **Verified onboarding API** (`codex/org-02-onboarding-api`): list the signed-in
   person's active GitHub memberships, owner-only setup, and joining an existing
   company. Reverify provider membership before access; persist no unverified grants.
3. **Repo-room discovery** (`codex/org-03-room-discovery`): list connected company
   repo rooms using existing installation/repository records and live per-repo
   access checks. Preserve the account room list and direct repo-room entry.
4. **Desktop onboarding**: optional company selection/setup after individual
   sign-in, multi-company support, and the existing standalone room path.
5. **Sidebar**: company selection above existing repo-room groups, personal/shared
   room navigation, and coherent search, pins, unread counts, and selection.
6. **Company links**: browser join page, safe sign-in continuation, and desktop
   incoming-link handling with a pending company destination.

Proof is incremental: migration integrity; provider and route authorization;
room discovery without private-repo disclosure; onboarding/navigation regressions;
and link continuation for signed-out, signed-in, and first-run users. A database
reset, billing, company-wide chat, and agent-runtime redesign are outside scope.

## Backend onboarding contract (slice 2)

- `GET /account/organizations` returns verified active GitHub organizations, the
  current provider role (`owner` or `member`), and separate `setup`/`joined` flags.
  An empty list is valid; the user can continue with personal/shared repo rooms.
- `POST /organizations/:organizationId/setup` requires a freshly verified owner
  and atomically sets up the company and joins that person. Repeated setup is
  idempotent. The ID is GitHub's numeric organization ID, not its mutable login.
- `POST /organizations/:organizationId/join` requires an active membership and
  an existing company. A member arriving before owner setup gets HTTP 409 with
  `organization_setup_required`.

The default OAuth scope includes `read:org`. Deployments overriding
`GITHUB_OAUTH_SCOPES` must include organization-read access; older credentials
may need GitHub sign-in again. Membership verification uses the authenticated
user's memberships endpoint, including private memberships. Provider errors
block company access without deleting joins; stored membership alone never
authorizes access. This slice does not synchronize the entire staff directory
or change repository permissions.

## Company room discovery contract (slice 3)

`GET /organizations/:organizationId/rooms` requires both a stored LetAgents join
and freshly verified active GitHub membership. It returns the existing canonical
repo room IDs, display names, repository IDs/full names, organization ID, and
current visibility. It does not create rooms or change their permissions.

Connected candidates come from active GitHub App installations targeting the
organization's immutable GitHub ID. Suspended/uninstalled installations, removed
repositories, and child rooms are excluded. Candidates are intersected with the
organization repository list fetched using the person's GitHub token; private
entries require explicit read permission. Both repository identity and current
full name must match so pending rename/transfer reconciliation cannot expose a
stale room. Provider failures return an error rather than a partial room list.

The company association is derived from the existing installation/repository
records rather than duplicated on rooms. The existing `/account/rooms` list and
direct repo-room entry remain unchanged, including external collaborators and
personal/shared rooms. Newly installed repositories appear after the existing
webhook synchronization creates their canonical room. Installation setup UI is
still room-based; company-level installation navigation belongs to the UI slice.

Provider list operations each have a 15-second deadline and a 10-page cap (100
entries/page). Exceeding the cap returns a verification error, never a silently
truncated list. Live GitHub consent/SSO and desktop UI are not validated by these
backend slices.

## Desktop onboarding (slice 4)

The desktop signs in as an individual, then offers an optional company step.
Owners can set up a company, members can join an existing one, and personal rooms
remain available even when GitHub organization verification fails. Connected
company repo rooms can be selected during first run. Selection is stored per
account and API origin; account changes invalidate in-flight company requests.

## Sidebar company scope (slice 5)

The workspace selector wraps the existing repo-room groups. Company discovery
adds unopened rooms to navigation while preserving known rooms' pins, child
rooms, and unread state. Search and Zen Mode use the scoped groups. Personal &
shared retains the existing account room view, including directly opened company
repos, so unconnected repositories and external collaboration remain reachable.
Company verification failures clear the company list rather than falling back
to cached private room groups. Returning to the app rechecks company membership.

## Company invitations and combined validation (slice 6)

Company links use `/join/<GitHub organization ID>` in the browser and
`letagents://join/<ID>` in desktop. Links select a destination; they grant no
access. Browser sign-in preserves the destination. Desktop persists the pending
ID across restarts and clears it only after joining or choosing personal rooms.
A newer invitation cannot be cleared by an older request. Packaged macOS apps
register the protocol; development runs do not replace an installed handler.

Run `npm --prefix apps/desktop run smoke:organizations` after dependency setup
for an isolated Electron journey against the built renderer. It uses a temporary
profile and simulated GitHub responses, without changing MCP configuration.
Screenshots and a JSON report go to `/tmp/letagents-org-onboarding-results`
(or `LETAGENTS_ORG_SMOKE_OUTPUT`). It checks owner setup, member waiting, repo
selection, company switching, empty rooms, provider failures, personal fallback,
and persisted invitations. This journey also caught and fixed the four-step
progress layout and sidebar switcher placement.

Combined branch validation: root/web and desktop builds, desktop typechecks,
967 renderer tests, backend organization/access/migration tests, link parsing,
auth redirect tests, packaging contract tests, and the Electron journey passed.
Live GitHub consent/SSO and installed-app OS protocol dispatch still need a real
account and packaged-app check. No production database was changed. Migration
0093 only adds organization and membership tables; no reset is required.

## Independent review follow-up

Separate reviewers checked backend slices 1–3, desktop slices 4–5, and links
in slice 6. Backend review found no actionable issue. Three UI/entry findings
were fixed and rechecked: direct HTTP company links now serve the Vue app;
explicitly opening a room outside a selected company switches to Personal &
shared; an incoming invitation hides Marketplace while it is being handled.
The HTTP entry regression and extended isolated desktop walkthrough cover these
paths. Existing CI now runs organization migration/storage/access tests.

The reviewed stack remains unmerged. Independent agent review is not a GitHub
approval from a separate human account. Live GitHub/SSO and installed-app protocol
dispatch remain the documented verification limits.
