# Dashboard Auth With Slack Design

## Goal

Replace the current shared-password-only dashboard access model with a unified authentication foundation that supports:

- existing admin login as a separate path
- Slack Sign in for existing Gooseherd users
- Slack Sign up for first-time users
- automatic synchronization of internal team membership from Slack user groups on every Slack login

Authorization is explicitly out of scope for this change. This design only establishes reliable user/admin authentication and a session model that can support authorization later.

## Current State

Dashboard access is currently protected by a global `DASHBOARD_TOKEN` or a single setup password hash stored in the singleton `setup` row. The login form accepts one shared password and grants a cookie that proves knowledge of that shared secret. This is enough for basic protection, but it does not identify which human is on the dashboard.

The codebase already has user and team identity primitives:

- `users` with `slackUserId`, `displayName`, and `isActive`
- `teams`
- `team_members`
- `org_role_assignments`

That means the missing piece is not identity storage. The missing piece is a real dashboard authentication/session layer that can authenticate either an admin principal or a user principal.

## Product Behavior

### Login Entry Points

The dashboard login page will expose three entry points:

- `Admin login`
- `Sign in with Slack`
- `Sign up with Slack`

`Admin login` preserves the current operational fallback for bootstrap, recovery, and system administration.

`Sign in with Slack` is for existing Gooseherd users. If the Slack identity does not map to an existing local user, the sign-in attempt fails with a clear error.

`Sign up with Slack` is for first-time users. The system still checks for an existing user first. If one exists, sign-up behaves like a normal Slack login. If one does not exist, the system creates the user and assigns internal teams based on Slack user group membership.

### Team Assignment Rule

Internal Gooseherd teams will be linked to Slack user groups such as `@devops` or `@team_one`.

When a user authenticates with Slack:

1. Gooseherd resolves the Slack user identity.
2. Gooseherd reads the Slack user groups that the person belongs to.
3. Gooseherd maps those groups to internal `teams`.
4. Gooseherd synchronizes `team_members` for Slack-managed memberships.

Slack user group membership is re-synced on every Slack login.

### Failure Behavior

If `Sign in with Slack` is used and no user exists for the Slack identity, show a clear “account not registered” error.

If `Sign up with Slack` is used, the user does not yet exist, and the person belongs to no mapped Slack user groups, reject sign-up with:

`Your Slack account is not assigned to any Gooseherd teams yet.`

## Scope Boundaries

### In Scope

- unified dashboard auth session layer
- admin login preserved as a separate auth method
- Slack OpenID Connect login
- distinct Sign in and Sign up user flows
- user auto-provisioning on Slack sign-up
- internal team sync from Slack user groups on every Slack login
- logout
- dashboard auth route/test updates

### Out of Scope

- authorization rules for what a logged-in user can see or do
- replacing admin login with user-backed org admin identities
- Slack-based role sync for PM/QA/engineer style functional roles
- background sync outside login events

## Architecture

### 1. Dedicated Dashboard Auth Session Layer

Dashboard auth must be separated from the existing agent-planning `sessions` table. Those records represent long-running work sessions, not browser authentication.

Introduce a dedicated dashboard auth session store, backed by a new table such as `dashboard_auth_sessions`.

Each dashboard session record stores:

- `id`
- `tokenHash`
- `principalType` as `"admin"` or `"user"`
- `userId` nullable
- `authMethod` as `"admin_password"` or `"slack"`
- `createdAt`
- `expiresAt`
- `lastSeenAt`
- `revokedAt` nullable

The browser cookie remains `gooseherd-session`, but it now contains a random opaque session token. The server stores only a hash of that token in the database.

This provides:

- explicit identity for each authenticated browser
- easy logout and revocation
- room for future authorization checks
- clean separation from the current shared-secret login

### 2. Principal Model

Do not add `users.isAdmin`.

The codebase already has `org_role_assignments`, which is the right long-term home for authorization concepts. This design does not implement authorization yet, but it should not create a conflicting admin model that will later need to be removed.

For now:

- admin login creates a session with `principalType="admin"` and no required `userId`
- Slack login creates a session with `principalType="user"` and a concrete `userId`

This keeps authentication and authorization separate while preserving an operational admin escape hatch.

### 3. Slack OpenID Connect Flow

Slack login uses the official modern `Sign in with Slack` OpenID Connect flow.

Required Slack OpenID behavior:

- authorization endpoint: `https://slack.com/openid/connect/authorize`
- scopes: `openid`, `email`, `profile`
- code exchange endpoint: `https://slack.com/api/openid.connect.token`
- optional current-user refresh endpoint: `https://slack.com/api/openid.connect.userInfo`

Required app configuration:

- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- redirect URI derived from `DASHBOARD_PUBLIC_URL` or set explicitly

Existing Slack config is not sufficient for this flow:

- `SLACK_BOT_TOKEN` is useful for user-group sync
- `SLACK_APP_TOKEN` is unrelated
- `SLACK_SIGNING_SECRET` is unrelated
- `SLACK_COMMAND_NAME` is unrelated

The login initiation flow should create a short-lived auth transaction carrying:

- `state`
- `nonce`
- `intent` as `signin` or `signup`

That transaction may be stored in a signed short-lived cookie or in a small DB table. The important requirement is that callback validation must verify `state`, verify `nonce`, and preserve the intended entry path (`signin` vs `signup`).

### 4. Slack User Provisioning

#### Sign In

`Sign in with Slack`:

1. resolve Slack identity
2. look up `users.slackUserId`
3. reject if user is missing
4. reject if user is inactive
5. sync Slack-managed team memberships
6. create dashboard auth session

#### Sign Up

`Sign up with Slack`:

1. resolve Slack identity
2. look up `users.slackUserId`
3. if user exists, continue as a normal Slack login
4. if user does not exist, resolve mapped teams from Slack user groups
5. if no mapped teams exist, reject sign-up
6. otherwise create `users` row with:
   - generated UUID
   - `slackUserId`
   - `displayName` from Slack identity/profile
   - `isActive = true`
7. create Slack-managed `team_members`
8. create dashboard auth session

Creation and initial membership assignment should happen in one transaction so that a failed sign-up does not leave behind orphaned users with no teams.

### 5. Internal Team Mapping To Slack User Groups

The current `teams` table has a `slackChannelId`, but that is not enough for sign-up and membership sync because the user-facing constructs `@devops` and `@team_one` are Slack user groups, not channels.

Add Slack user group linkage to `teams`:

- `slackUserGroupId` nullable and unique
- optionally `slackUserGroupHandle` as a denormalized diagnostic/cache field

`slackUserGroupId` is the source-of-truth mapping key because handles can be renamed in Slack.

Only teams with a configured `slackUserGroupId` participate in Slack-driven membership sync.

### 6. Membership Synchronization Model

Slack must not overwrite every membership row indiscriminately. Some assignments may later be managed manually or through other product workflows.

To support safe resync, add provenance to `team_members`:

- `membershipSource` with values `"manual"` or `"slack_user_group"`

Sync rules on every successful Slack login:

- for every mapped team whose Slack user group contains the user, ensure a `team_members` row exists with `membershipSource="slack_user_group"`
- for every mapped team whose Slack user group no longer contains the user, remove only rows with `membershipSource="slack_user_group"`
- leave `membershipSource="manual"` rows untouched

This makes Slack the source of truth for Slack-managed memberships only.

## Data Model Changes

### New Table: `dashboard_auth_sessions`

Purpose: browser authentication sessions for the dashboard.

Main indexes:

- unique index on `tokenHash`
- index on `userId`
- index on `expiresAt`
- index on `revokedAt`

### Modified Table: `teams`

Add:

- `slackUserGroupId`
- optional `slackUserGroupHandle`

### Modified Table: `team_members`

Add:

- `membershipSource`

Default should be `"manual"` so existing data remains valid and stable.

## Route Design

### Existing Routes Retained

- `GET /login`
- `POST /login`

These remain the admin login path.

### New Routes

- `POST /logout`
- `GET /auth/slack/signin`
- `GET /auth/slack/signup`
- `GET /auth/slack/callback`

Behavior:

- `GET /auth/slack/signin` starts Slack OpenID flow with intent `signin`
- `GET /auth/slack/signup` starts Slack OpenID flow with intent `signup`
- `GET /auth/slack/callback` handles shared callback logic and dispatches behavior based on stored intent
- `POST /logout` revokes the current dashboard auth session and clears the cookie

## Auth Check Behavior

The existing `checkAuth()` logic currently validates a shared token/password directly from headers and cookies. That must be refactored into:

1. setup-mode protection, which can still use the setup password before bootstrap is complete
2. post-setup dashboard session validation, which resolves the current principal from `dashboard_auth_sessions`

Post-setup behavior becomes:

- if a valid dashboard session exists, request is authenticated
- if no valid session exists, redirect HTML routes to `/login` and return 401 for API routes

The backward-compatibility path of “no auth configured means allow everything” should be re-evaluated during implementation, but the design assumption is that once this ships, normal dashboard usage should be session-based.

## Slack API Usage

Two different Slack capabilities are used for two different purposes:

### OpenID Login

Uses Slack OpenID endpoints and OAuth client credentials to authenticate the human.

### User Group Sync

Uses the app bot token with `usergroups:read` to inspect workspace user groups and group membership.

The sync logic should:

1. load all internal teams that have `slackUserGroupId`
2. query Slack for membership of those user groups
3. compute the internal team set for the authenticated Slack user
4. apply membership diff for `membershipSource="slack_user_group"`

This can be implemented either by:

- loading `usergroups.list` and calling `usergroups.users.list` for mapped groups, or
- another equivalent Slack API strategy with the same correctness guarantees

The implementation should optimize for correctness first and only optimize API call count if needed.

## Error Handling

The login experience should surface specific errors:

- Slack OAuth not configured
- Slack callback state mismatch
- Slack callback nonce mismatch
- Slack code exchange failure
- Slack identity missing required fields
- Slack user is not registered for sign-in
- Slack sign-up found no mapped Gooseherd teams
- Slack sync failed because bot token lacks `usergroups:read`
- inactive local user

Error pages/messages should be human-readable and should not leak secrets or raw token payloads.

## Security Requirements

- dashboard auth session cookie must be `HttpOnly`
- `Secure` must be set when `DASHBOARD_PUBLIC_URL` is HTTPS
- `SameSite=Strict` remains acceptable for first-party dashboard navigation
- dashboard auth session token must be random and opaque
- server stores only the token hash
- Slack callback must validate `state` and `nonce`
- Slack tokens and client secret must never be written to logs
- logout must revoke the session server-side, not just clear the cookie client-side

## Testing Strategy

### Unit Tests

- dashboard auth session creation
- dashboard auth session lookup and expiration
- dashboard auth session revocation/logout
- admin login through new session layer
- Slack callback validation for happy path
- state mismatch rejection
- nonce mismatch rejection
- sign-in missing user rejection
- sign-up auto-create success
- sign-up rejection when no mapped teams exist
- team membership resync add/remove behavior
- manual memberships remain untouched during Slack resync

### Integration Tests

- `GET /login` renders admin + Slack options
- `POST /login` still authenticates admin path
- `GET /auth/slack/signin` starts OpenID flow
- `GET /auth/slack/signup` starts OpenID flow
- callback success creates authenticated session cookie
- authenticated dashboard routes accept session cookies
- logout revokes session and redirects user back to login

## Implementation Notes

- Keep the existing setup password flow for incomplete setup so first-time bootstrapping still works.
- Do not store functional roles like PM/QA/engineer in the session. Those belong in the database and will later be consulted by authorization logic.
- Do not use Slack group handles as the only mapping key because handles can change.
- Do not create a parallel admin boolean on `users`; future admin authorization should go through org-level roles.

## Success Criteria

This design is complete when:

- admin login still works
- existing users can sign in with Slack
- first-time users can sign up with Slack only when they belong to at least one mapped Slack user group
- internal `team_members` are resynchronized from Slack user groups on every Slack login
- the dashboard authenticates requests through real server-backed sessions rather than a shared cookie hash of one global secret
- the resulting auth/session model is a clean base for later authorization work
