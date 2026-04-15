# Authorization Design For Work Items

## Goal

Define a clear authorization model for Gooseherd work items that sits on top of the new dashboard authentication work.

The model must support:

- users and teams
- team-scoped functional roles such as `pm`, `engineer`, `designer`, `qa`
- org-scoped system roles such as `admin`
- actor identity derived from server-side dashboard session, not client-supplied user ids
- review and approval routing during `product_discovery`
- mostly automated workflow transitions
- restricted manual transitions
- explicit admin override behavior

This design is intentionally scoped to work item authorization. Authentication, session storage, and external identity login flows are out of scope except where they provide the current actor identity.

The critical boundary is:

- the acting principal must be resolved from the authenticated server-side session
- request bodies must not be treated as the source of actor identity

## Problem

The current code already contains the main pieces of authorization, but they are partially mixed together:

- `team_members` stores team membership and `functionalRoles`
- `org_role_assignments` stores org-wide roles
- `review_requests.targetType` and `targetRef` route workflow requests to users, teams, or roles
- `WorkItemAuthorization` currently uses these same sources both for routing review work and for granting broad management powers
- dashboard APIs currently accept actor identifiers such as `actorUserId` or `createdByUserId` from request bodies instead of deriving them from server-side session state

As a result, three different concerns risk collapsing into one:

1. who a user is in the organization
2. what actions a user is allowed to perform
3. who is expected to participate in a specific workflow step

If these concerns stay coupled, team roles such as `engineer` or `qa` will start to imply powers they should not have, and review-target concepts will become indistinguishable from management privileges.

If actor identity stays client-supplied, any later capability model will remain insecure because the caller can impersonate another user by submitting a different user id.

## Recommendation

Split authorization into three explicit layers:

1. `Identity`
2. `Capabilities`
3. `Workflow policy`

This is the smallest design that matches the current schema and workflow engine without introducing a heavy generic ACL or permission matrix.

## Layer 1: Identity

Identity answers:

- which teams a user belongs to
- which functional role a user has inside a given team
- which system role a user has across the organization

### Existing entities to keep

- `users`
- `teams`
- `team_members`
- `org_role_assignments`

### Meaning of each source

`team_members`

- team membership only
- team-scoped functional roles only
- examples: `pm`, `engineer`, `designer`, `qa`

`org_role_assignments`

- org-scoped system authority only
- should stay very small
- current required role: `admin`
- having some org role does not create generic management power
- elevated authorization checks should target explicit org roles such as `admin`, not "any org role"

### Important interpretation rule

`pm` does not mean "global product manager" and does not mean "generic elevated user".

It means:

- this user is a PM in this specific team

`admin` does not mean "normal workflow participant".

It means:

- this user can perform exceptional global override actions

### Explicit non-goal

Do not introduce a separate `work_item_owner` or `driver` entity. The user confirmed this is unnecessary.

Process ownership for manual actions is derived from:

- the work item's `ownerTeamId`
- membership in that team
- presence of functional role `pm` in that team

## Layer 2: Capabilities

Capabilities answer:

- may this actor perform this class of action at all?

Capabilities are not stored as a generic database permission matrix. They are derived in application code from identity plus local work item context.

This keeps the model simple and avoids over-design.

### Core capabilities

`work_item.create`

- allowed for any active member of the owner team
- allowed for `admin`

`review.request.create`

- allowed for PM of the owner team
- allowed for `admin`

`review.respond.self`

- allowed only for the actor targeted by the given `review_request`
- target resolution may be direct (`user`) or derived from team/team-role/org-role targeting
- for `targetType = team`, any active member of the targeted team may respond

`work_item.transition.manual`

- allowed for PM of the owner team
- allowed for `admin`

`work_item.override`

- allowed only for `admin`
- for actions such as force-transition, cancel, reopen, or emergency recovery

### Key rule

Functional roles such as `engineer`, `designer`, and `qa` do not grant generic management powers.

They are used for:

- review routing
- approval routing
- determining whether a user may answer a workflow request addressed to a team role

They are not used for:

- manual state transitions
- item-wide management
- emergency override

## Layer 3: Workflow Policy

Workflow policy answers:

- is this action allowed in this workflow and state right now?

This is separate from capabilities on purpose.

Example:

- a PM may have permission to perform manual transitions
- but workflow policy may still reject a transition because required reviews are incomplete

### Separation of responsibilities

Capability check:

- "Can actor X ever do action Y on this item?"

Workflow policy check:

- "Is action Y valid for this item in its current state?"

### Product discovery policy

For `product_discovery`:

- most transitions should stay automated
- review outcomes drive normal state progress
- final manual confirmation belongs to PM of the owner team
- `admin` may use explicit override paths when necessary

This gives a clean split:

- workflow engine owns normal progression
- PM owns bounded manual confirmation and management
- admin owns exceptional recovery

## Review Routing Model

The existing `review_requests` model is structurally correct and should remain the workflow-assignment layer:

- `targetType = user`
- `targetType = team`
- `targetType = team_role`
- `targetType = org_role`

This layer answers:

- who should respond to this review or approval request?

It does not answer:

- who can generally manage the work item?

### Recommended meaning of targets

`user`

- request a response from one explicit person

`team`

- request a team-level response
- any active member of the targeted team may close the request
- this is a responder pool model, not a requirement that every member of the team respond

`team_role`

- request a response from users with a specific functional role within a given team or the owner team
- examples: `qa`, `engineer`, `pm`, `designer`

`org_role`

- request a response from a small org-scoped authority role
- use sparingly
- current built-in elevated org role is `admin`
- future org roles may be added explicitly, but they must not be treated as generic superuser roles

### Critical design rule

Routing targets are not the same thing as management roles.

A user may be a valid review responder because they match `team_role = qa`, while still having no ability to manually move the work item between states.

## Actor Rules For Manual Actions

### Manual transitions

Manual transitions for a work item are allowed only to:

- PMs of the owner team
- `admin`

This includes discovery-specific bounded actions such as:

- confirming discovery completion
- sending the item back when manual PM judgment is required

### Override actions

Override actions are reserved for `admin`.

These should be modeled explicitly rather than hidden inside ordinary management methods.

Examples:

- force transition ignoring normal policy
- cancel stuck work
- reopen completed work
- recover from inconsistent or exceptional states

Override actions must always emit an audit event with:

- actor
- timestamp
- reason
- original state
- resulting state

### No broad team-member management

Being on the owner team alone should not grant full item management.

This is the main behavioral change from the current coarse authorization.

The reason is simple:

- team membership expresses affiliation
- PM expresses process ownership
- admin expresses global override authority

Each of these must stay distinct.

## Actor Derivation

Authorization must operate on a server-resolved principal, not on client-submitted actor ids.

### Required rule

- dashboard and API handlers must derive the current actor from the authenticated server-side session
- JSON fields such as `actorUserId`, `authorUserId`, `requestedByUserId`, and `createdByUserId` must not be trusted as authority-bearing inputs

### Practical implication

Service methods may still accept an actor parameter internally, but the caller that constructs that parameter must be server-side code using session state, not browser-submitted identity.

## Admin Session Model

The system currently supports a password-based dashboard admin session in addition to user-backed Slack sessions.

This principal must be modeled explicitly in authorization and audit logic.

### Principal forms

`user`

- a normal authenticated user session backed by `users.id`

`admin_session`

- a dashboard session authenticated via admin password
- may not have a backing `userId`
- is a special dashboard principal, not a normal org member record
- may use explicit admin-only authorization paths exposed by the dashboard
- must not automatically receive ordinary work item management capabilities that are intended for PMs of the owner team

### Important rule

Do not pretend that `admin_session` is a normal workflow participant.

It exists to:

- access admin-only dashboard controls
- execute explicit override actions
- perform rare emergency or recovery operations
- use other explicit admin-only flows only where the handler intentionally supports non-user admin principals

It does not imply:

- team membership
- functional team role
- ordinary workflow participation semantics
- generic substitution for every capability granted to a real user with org role `admin`

## Proposed Code Structure

### Identity queries

Keep identity lookup concerns in a store-like component similar to the existing `WorkItemIdentityStore`.

That component should expose facts, not decisions:

- `getUser`
- `getTeam`
- `isUserOnTeam`
- `userHasTeamRole`
- `userHasOrgRole`
- `listUsersForTeamRole`
- `listUsersForOrgRole`

### Authorization service

Replace broad checks such as "can manage item" with narrow action-specific checks.

Recommended surface:

- `canCreateWorkItem(actor, ownerTeamId)`
- `canRequestReview(actor, workItem)`
- `canRespondToReviewRequest(actor, workItem, reviewRequest)`
- `canApplyManualTransition(actor, workItem, transition)`
- `canOverrideWorkItem(actor, workItem, overrideAction)`

Assertion helpers may wrap these boolean decisions:

- `assertCanCreateWorkItem(...)`
- `assertCanRequestReview(...)`
- `assertCanRespondToReviewRequest(...)`
- `assertCanApplyManualTransition(...)`
- `assertCanOverrideWorkItem(...)`

The current coarse helper should be removed.

Specifically, do not preserve a broad rule equivalent to:

- creator-as-manager
- any-owner-team-member-as-manager
- any-org-role-as-manager

### Workflow policy service

Keep workflow validation separate from authorization.

Recommended surface:

- `isTransitionAllowed(workItem, transition, context)`
- `evaluateDiscoveryReviewRound(...)`
- `canConfirmDiscovery(workItem, context)`

The current `product-discovery-policy.ts` is already the correct direction and should remain independent from identity and actor role lookup.

## Data Model Impact

### Required database changes

None are required to adopt the conceptual split.

The current tables are sufficient for the model:

- `team_members.functional_roles`
- `org_role_assignments.org_role`
- `review_requests.target_type`
- `review_requests.target_ref`

### Strongly recommended code-level typing improvements

Add explicit enums or union types for:

- team functional roles
- org roles
- capability names
- transition names
- override action names

Suggested initial roles:

Team functional roles:

- `pm`
- `engineer`
- `designer`
- `qa`

Org roles:

- `admin`

Suggested initial override actions:

- `force_transition`
- `cancel`
- `reopen`

This keeps the schema stable while reducing accidental string drift in business logic.

## Behavioral Changes From Current Implementation

### Current behavior

The current authorization allows broad management if the actor is:

- the creator
- any member of the owner team
- any user with any org role
- and many dashboard APIs still accept the actor identity directly from request payloads

This is too permissive for the intended process model.

### Target behavior

Broad item management should be narrowed to:

- PM of owner team
- `admin`

For clarity:

- a real user with org role `admin` may receive the full set of admin-defined capabilities
- `admin_session` may use only explicit admin-only dashboard paths
- `admin_session` must not be treated as a substitute for PM-style manual management actions unless a specific handler is intentionally defined as an admin-only path

Review response should remain target-aware:

- direct user target must be answered by that user
- team target may be answered by any active member of the targeted team
- team-role target may be answered by a matching user in the relevant team
- org-role target may be answered by a matching org-role holder

Creator identity alone should not grant durable management rights unless the creator also matches one of the allowed process roles.

Having any org role must not grant generic elevated power. Only explicit roles such as `admin` may grant override or management capabilities where the policy says so.

## Audit And Observability

Authorization-sensitive actions should produce explicit work item events.

At minimum:

- review request created
- review response recorded
- manual transition performed
- override performed
- override rejected

Important event metadata:

- actor user id
- actor principal type
- actor auth method
- item id
- action name
- decision result
- reason when provided

When the acting principal is a password-based admin session without `userId`, audit events must still record the actor as an explicit non-user principal rather than leaving actor identity ambiguous.

This is especially important for `admin` paths, which should remain rare and traceable.

## Testing Strategy

### Identity tests

Verify:

- team role lookup is team-scoped
- org role lookup is global
- inactive users cannot act

### Authorization tests

Verify:

- owner-team PM can manually manage an item
- non-PM team members cannot manually manage an item
- admin can override
- creator without PM role cannot automatically manage the item
- any non-admin org role does not automatically gain management powers
- review responders are matched strictly by target rules
- team-targeted review may be answered by any active member of the targeted team
- actor identity is taken from server-side session, not request body

### Workflow policy tests

Verify:

- PM manual confirmation is blocked until workflow policy permits it
- completed required reviews advance discovery as expected
- override path is explicit and audited

## Migration Path

Implementation should proceed with minimal disruption:

1. introduce typed role and capability concepts in code
2. make dashboard handlers derive actor identity from server-side session instead of request payload fields
3. narrow `WorkItemAuthorization` from broad "manage item" checks to action-specific checks
4. preserve existing review target resolution, including team-target semantics of "any active member may respond"
5. move manual state-change endpoints and service calls to PM-or-admin rules
6. add explicit admin override methods and events, including support for `admin_session` principals

This allows the codebase to evolve from coarse authorization to process-aware authorization without changing the core schema first.

## Final Model Summary

Use the following mental model throughout the codebase:

- `team_members` tells us who belongs to a team and what their functional role is there
- `org_role_assignments` tells us who has exceptional global authority
- `review_requests` tells us who is assigned to respond in a specific workflow step
- authorization capabilities tell us what class of action the actor may perform
- workflow policy tells us whether the action is valid in the current state

In short:

- PM of owner team = normal manual process authority
- admin = explicit global override authority
- engineer/designer/qa = workflow participants, not generic managers
- review targets = assignment mechanism, not management mechanism

This split is recommended as the long-term authorization boundary for Gooseherd work items.
