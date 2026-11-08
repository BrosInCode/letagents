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

## 2026-11-08 API rework (slices 1-2)

Slice 1: `rooms.organization_id` (optional, `ON DELETE SET NULL`, partial index)
is added in `0143_organizations.sql`. A company can own work rooms.

Slice 2:

- Company routes accept only an interactive app session. Owner tokens, remote
  MCP tokens, and agent sessions get 403 `human_app_session_required`. POST
  setup and join also need a same-origin write, else 403
  `cross_site_write_refused`.
- `readGitHubOrganizationAccess` makes one paged GitHub read (no state filter)
  and returns `{ memberships, invitations, ssoRequiredOrgIds }`.
  `listGitHubOrganizationMemberships` wraps it. A token whose `x-oauth-scopes`
  lacks `read:org`, `write:org`, and `admin:org` raises
  `GitHubOrganizationScopeError` (403 `github_scope_required`). A missing
  header (GitHub App user tokens) is not judged. `x-github-sso:
  partial-results; organizations=...` yields numeric IDs not already active.
- `GET /account/organizations` now returns `organizations`, `invitations`
  (`{ github_org_id, login, avatar_url }`), and `sso_required`
  (`{ github_org_id, login | null }`).
- `GET /auth/github/organizations[?login=]` (browser only) sends the person to
  GitHub with `read:org` added to the configured scopes. The callback refreshes
  the GitHub token on all sessions of the account, so the desktop picks it up.
  `/auth/github/organizations/done` shows "GitHub access updated".
- Default `GITHUB_OAUTH_SCOPES` is `read:user,repo,read:org`; the docs page was
  corrected.

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

## 2026-11-08 API rework (slice 3)

- `GET /organizations/:id/rooms` keeps a repo room only when the app's room
  access rule (`filterAccountIdsWithRoomAccess`) confirms an allow for the
  person (6 checks at a time). GitHub's repo list alone is not enough, because
  it also lists public repos to people with no role.
- A 403 from GitHub with `x-github-sso: required; url=...` returns 403
  `organization_sso_required`; `authorize_url` is present only for an `https:`
  `github.com` URL.
- Ad-hoc rooms with `rooms.organization_id` set are listed when the person is a
  room member or admin. Every entry has the shape
  `{ kind: "repo" | "room", room_id, display_name, full_name, github_repo_id,
  organization_id, visibility }`; ad-hoc rooms have `kind: "room"` and nulls.
- `POST /projects` (the call behind the desktop "New room" dialog) accepts an
  optional `organization_id` (digits). It needs an app session, a same-origin
  write, a live active GitHub membership, and a joined company. Errors:
  `invalid_organization_id` (400), `human_app_session_required`,
  `cross_site_write_refused`, `organization_membership_required`,
  `organization_join_required`, `github_scope_required` (403),
  `github_signin_required` (401), `organization_verification_unavailable` (503).
  The 201 reply then also carries `organization_id`.

## Desktop onboarding (slice 4)

The desktop signs in as an individual, then offers an optional company step.
Owners can set up a company, members can join an existing one, and personal rooms
remain available even when GitHub organization verification fails. Connected
company repo rooms can be selected during first run. Selection is stored per
account and API origin; account changes invalidate in-flight company requests.

### Rework (2026-11-08)

- The company step follows the approved mockup: one row per GitHub organization
  in a radio group, with "All rooms" (no filter) first. The main button names what
  happens: Continue, Set up <company>, or Join <company>.
- People with no organizations, invitations or blocked organizations skip the
  step; Back from the room step then returns to GitHub.
- A sign-in without `read:org` shows "Allow on GitHub". The main process opens
  `/auth/github/organizations` on the LetAgents server (slice 2), and the app
  checks again when the window regains focus.
- Pending GitHub invitations show "Accept on GitHub". Organizations that GitHub
  hides behind single sign-on show "Authorize".
- The IPC layer returns a status for every refusal instead of throwing, so the
  renderer can show the right state. The main process builds every URL it opens.
- A window-focus check runs at most once a minute while the list is ready.
- The room step lists the company's rooms (repo rooms and rooms with no repo)
  above the usual three ways to start.

## Sidebar company scope (slice 5)

The workspace selector wraps the existing repo-room groups. Company discovery
adds unopened rooms to navigation while preserving known rooms' pins, child
rooms, and unread state. Search and Zen Mode use the scoped groups. Personal &
shared retains the existing account room view, including directly opened company
repos, so unconnected repositories and external collaboration remain reachable.
Company verification failures clear the company list rather than falling back
to cached private room groups. Returning to the app rechecks company membership.

### Rework (2026-11-08)

- The company filter now lives on the Rooms heading (the approved mockup), not
  in a select above the sidebar. Clicking it opens a menu anchored to the
  heading: "All rooms", each company, GitHub invitations, single sign-on
  organizations, a permission prompt when `read:org` is missing, and "Refresh
  from GitHub". The count and collapse chevron stay on the right of the heading.
  People with nothing to choose keep the plain Rooms heading.
- "Personal & shared" is now "All rooms".
- Pinned rooms stay visible in every company, because pins are personal.
- Rooms that a GitHub check cannot confirm are not shown; rooms already shown
  stay while a check runs or when GitHub does not answer.
- The company home replaces the main view only when a company is selected and
  the active room is not one of its rooms. It shows one state at a time: no
  rooms yet, checking, GitHub did not answer, permission needed, or single
  sign-on, each with one main action.
- The company owns work rooms. With a company selected, the New room dialog's
  "Where it lives" offers "In <company>" first (and selects it). The room is
  created with `organization_id` (slice 3) and is listed in the company at once.
- The window-focus check moved to slice 4 and runs at most once a minute.
