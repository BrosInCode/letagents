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
- Work rooms can belong to the company. With a company selected, the New room
  dialog's "Where it lives" offers "In <company>" first (and selects it). The
  room is created with `organization_id` (slice 3) and is listed in the company
  at once. Company control over such rooms (admins, removal when someone leaves
  the GitHub organization) is the next stack, so the dialog promises only the
  listing.
- The sidebar filter and the company home use the company only after GitHub
  confirms it as joined (`activeId`). A saved choice alone, at launch or when
  GitHub does not answer, shows All rooms.
- The window-focus check moved to slice 4 and runs at most once a minute.

## Company invitations and combined validation (slice 6)

Company links use `/company/<GitHub organization ID>` in the browser and
`letagents://company/<ID>` in desktop (renamed from `/join/` on 2026-11-08,
because "join" already means joining a room). Links select a destination; they grant no
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
0143 adds organization and membership tables and the optional
`rooms.organization_id`; no reset is required.

### Rework (2026-11-08)

- A company link opens a dialog over any view instead of replacing the main
  view. The desktop dialog and the web page share one panel
  (`shared/ui/company-invite/`), styled like the Give-an-agent panel. One rule,
  `companyInviteView`, decides what it shows: join, set up, waiting for an
  owner, already joined, invited on GitHub (accept there first), single
  sign-on, permission needed, GitHub did not answer, or not a member. A missing
  permission or an outage never reads as "not a member".
- The not-a-member text names the signed-in GitHub account, tells the person to
  ask an owner or use the account they added, and tells outside collaborators
  that their repo rooms still open from All rooms. The web page names the
  signed-in account on every join.
- The web page `/company/<id>` follows the Ask-for-an-agent link page: "Open in
  LetAgents" first, with download links; joining in the browser is a second
  path. GitHub pages open in a new tab, and the page checks again on focus.
- The company menu copies `https://…/company/<id>`. The New room dialog's join
  box also accepts a company link (`https://letagents.chat/company/<id>` or
  `letagents://company/<id>`) and opens the company dialog.
- The smoke journey now covers the radio-row company step, the Rooms-heading
  menu, the empty and GitHub-outage company home, the link dialog over another
  view, joining from a link, a new room inside the company, a pasted company
  link, and the All rooms fallback (14 checks). Its window runs with
  `backgroundThrottling: false`, because a hidden window runs no animation
  frames and a dialog's leave transition then never ends.

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

## Rebuilt on staging (2026-11-07)

The original PRs (#1172–#1178) were closed unmerged on 2026-09-18 with their
branches deleted, and staging's history was rewritten afterwards. The same
eight commits were cherry-picked onto staging `bc107382b`. What changed:

- The migration is `drizzle/0143_organizations.sql` (0093 is taken on staging).
- `App.vue` is now a set of composables. The company code lives in
  `composables/app/useAppCompany.ts` (`useAppCompany` after the state,
  `useAppCompanyNavigation` after the sidebar entries). The account rooms for
  navigation, the company filter on sidebar projects, the window-focus refresh
  and the explicit-open fallback moved into `useAppNavigation`,
  `useAppSidebarEntries` and `useAppSessionActions`.
- Staging already owns `letagents://` (ask links): the single-instance lock,
  the protocol registration and the macOS `CFBundleURLTypes` entry. Company
  links now only add their own `open-url` and `second-instance` listeners next
  to the ask links, so there is no second lock or scheme registration.
- An invitation also hides Messages, Inbox and My Work, which did not exist in
  September, in the same way it hides Settings and Marketplace.
- CI runs the organization tests in `integration-db-tests` group 4;
  `web-routes.test.ts` already runs in `build-checks`.
- The Electron smoke follows staging's New room tabs and answers the Messages
  panel's `conversations` calls.

Validation on the rebuilt stack: root and desktop type-checks, Vue lint, web
build, 2541 renderer tests, 598 web tests, packaging tests, link and IPC
registration tests, organization DB tests on a private Postgres, and the
Electron organization smoke (all 11 checks, no console errors).

## Review of the rework (2026-11-08)

An independent agent reviewed the whole stack against staging. It found no
server-side access leak. Fixed, each in the slice that owns the code:

- Slice 4: one request counter served the list check and the company choice,
  so a list check during a join locked the company dialog, and choosing All
  rooms while the list loaded left it "checking" for good. Two counters now.
- Slices 4–6: the filters used the saved company ID; a failed first check then
  showed a blank main view. They now use the confirmed company (`activeId`).
- Slice 3: the room list dropped rooms whose access check GitHub could not
  answer, and returned 200. It now answers 503.
- Slices 2–3: an organization hidden by single sign-on was treated as "not a
  member" and its stored join was deleted. It now answers
  `organization_sso_required` and keeps the join.
- Slice 5: the New room dialog promised company ownership that is not built
  yet; it now promises only the listing.

Known limits, not fixed here: an organization with more than 1,000 repos
visible to the person returns 503 from the room list (10 pages of 100); and the
OAuth `state` is not tied to the browser, the same login-CSRF exposure the
existing GitHub login has.
