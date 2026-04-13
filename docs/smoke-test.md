# Work Items V1 Smoke Test

This guide describes a practical local smoke test for the `WorkItem v1` flow.

It covers:
- `product_discovery` board rendering
- `ReviewRequest` history rendering
- PM confirmation flow
- `feature_delivery` board rendering

It does not replace automated tests. It is meant to validate that the live dashboard and runtime wiring behave correctly end-to-end.

## Prerequisites

Start PostgreSQL:

```bash
docker compose up -d postgres
```

Apply migrations:

```bash
docker compose run --rm \
  -v "$PWD:/app" \
  --entrypoint sh gooseherd \
  -lc 'cd /app && npm run db:migrate'
```

Start the app with the local dashboard:

```bash
docker compose run --rm --service-ports \
  -v "$PWD:/app" \
  --entrypoint sh gooseherd \
  -lc 'cd /app && APP_NAME=Huble DASHBOARD_ENABLED=true DASHBOARD_HOST=0.0.0.0 DASHBOARD_PORT=8787 npm run dev'
```

The dashboard should be available at `http://127.0.0.1:8787/`.

## Local Login

If the local dashboard is protected by a setup password, either use the existing password or set a known one directly in the local dev database.

Example password used for smoke checks:

```text
smoketest123
```

Example hash generation:

```bash
node -e "const {scryptSync, randomBytes}=require('node:crypto'); const password='smoketest123'; const salt=randomBytes(16); const hash=scryptSync(password,salt,64); process.stdout.write('scrypt:'+salt.toString('hex')+':'+hash.toString('hex'));"
```

Then write the generated hash into the `setup.password_hash` field and restart the local app process so it reloads the new hash.

## Smoke Dataset

Create a PM, engineer, QA, and one team:

```bash
docker compose exec -T postgres psql -U gooseherd -d gooseherd -c "
insert into users (id, slack_user_id, jira_account_id, display_name) values
('11111111-1111-1111-1111-111111111111','U_PM_SMOKE','JIRA_PM_SMOKE','Smoke PM'),
('22222222-2222-2222-2222-222222222222','U_ENG_SMOKE',null,'Smoke Engineer'),
('33333333-3333-3333-3333-333333333333','U_QA_SMOKE',null,'Smoke QA')
on conflict (id) do nothing;

insert into teams (id, name, slack_channel_id) values
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','growth','C_GROWTH_SMOKE')
on conflict (id) do nothing;

insert into team_members (team_id, user_id, functional_roles) values
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111',array['pm']),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222',array['engineer']),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','33333333-3333-3333-3333-333333333333',array['qa'])
on conflict (team_id, user_id) do nothing;
"
```

Create a discovery work item through the real dashboard API:

```bash
curl -H 'Cookie: gooseherd-session=<session-cookie>' \
  -X POST http://127.0.0.1:8787/api/work-items/discovery \
  -H 'content-type: application/json' \
  -d '{
    "title":"Smoke discovery item",
    "summary":"Browser smoke for discovery workflow",
    "ownerTeamId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "homeChannelId":"C_GROWTH_SMOKE",
    "homeThreadTs":"1740001111.100",
    "createdByUserId":"11111111-1111-1111-1111-111111111111"
  }'
```

Save the returned discovery id. It will be referred to below as `<discovery-id>`.

Drive the discovery item to `waiting_for_pm_confirmation` and add review history:

```bash
docker compose run --rm \
  -v "$PWD:/app" \
  --entrypoint sh gooseherd \
  -lc 'cd /app && node --import tsx -e "
import { initDatabase, closeDatabase } from \"./src/db/index.ts\";
import { WorkItemService } from \"./src/work-items/service.ts\";

const db = await initDatabase(\"postgres://gooseherd:gooseherd@postgres:5432/gooseherd\");
const svc = new WorkItemService(db);

await svc.startDiscovery(\"<discovery-id>\");

const requests = await svc.requestReview({
  workItemId: \"<discovery-id>\",
  requestedByUserId: \"11111111-1111-1111-1111-111111111111\",
  requests: [{
    type: \"review\",
    targetType: \"user\",
    targetRef: { userId: \"22222222-2222-2222-2222-222222222222\" },
    title: \"Engineering review for smoke discovery\",
    requestMessage: \"Please review the spec draft\",
    focusPoints: [\"scope\", \"naming\"]
  }]
});

await svc.recordReviewOutcome({
  reviewRequestId: requests[0].id,
  outcome: \"approved\",
  authorUserId: \"22222222-2222-2222-2222-222222222222\",
  comment: \"Looks ready to me.\",
  source: \"dashboard\"
});

await closeDatabase();
"'
```

Create a delivery work item:

```bash
docker compose run --rm \
  -v "$PWD:/app" \
  --entrypoint sh gooseherd \
  -lc 'cd /app && node --import tsx -e "
import { initDatabase, closeDatabase } from \"./src/db/index.ts\";
import { WorkItemService } from \"./src/work-items/service.ts\";

const db = await initDatabase(\"postgres://gooseherd:gooseherd@postgres:5432/gooseherd\");
const svc = new WorkItemService(db);

await svc.createDeliveryFromJira({
  title: \"Smoke delivery item\",
  summary: \"Browser smoke for delivery workflow\",
  ownerTeamId: \"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\",
  homeChannelId: \"C_GROWTH_SMOKE\",
  homeThreadTs: \"1740002222.200\",
  jiraIssueKey: \"HBL-SMOKE-1\",
  createdByUserId: \"11111111-1111-1111-1111-111111111111\"
});

await closeDatabase();
"'
```

## Manual Dashboard Smoke

Open the dashboard:

```text
http://127.0.0.1:8787/
```

Log in if required.

Switch to `Board`.

### Product Discovery

Set workflow to `Product Discovery`.

Expected results:
- one item appears in `Waiting For PM Confirmation`
- the card title is `Smoke discovery item`
- the detail pane shows:
  - `Waiting For PM Confirmation`
  - `Awaiting PM Decision`
  - `All Required Reviews Received`

In `Review Requests`, verify:
- the completed review request is visible
- the review comment history is visible
- the comment body `Looks ready to me.` is rendered

In `Events`, verify at least:
- `review_request.created`
- `review_request.comment_added`
- `review_request.completed`
- `work_item.state_changed`

### PM Approve

Click `PM Approve`.

When prompted, use:

```text
PM user id: 11111111-1111-1111-1111-111111111111
Jira issue key: HBL-SMOKE-2
```

Expected results:
- the discovery item moves to `Done`
- the detail pane shows:
  - `pm_approved`
  - `jira_created`
  - `delivery_work_item_created`

### Feature Delivery

Switch workflow to `Feature Delivery`.

Expected results:
- the board shows at least one delivery item with `Jira` key `HBL-SMOKE-1`
- after PM approval, an additional delivery item linked to `HBL-SMOKE-2` should exist
- both items should render normally in the board and detail pane

## Optional API Checks

Check work item list:

```bash
curl -H 'Cookie: gooseherd-session=<session-cookie>' \
  http://127.0.0.1:8787/api/work-items?workflow=product_discovery
```

Check review request comments:

```bash
curl -H 'Cookie: gooseherd-session=<session-cookie>' \
  http://127.0.0.1:8787/api/work-items/<discovery-id>/review-requests/<review-request-id>/comments
```

## Known Caveats

- If a real Slack config is loaded, creating review requests through the live API can try to post notifications into Slack immediately.
- Using fake `homeChannelId` values can cause `channel_not_found`.
- For purely local smoke checks, it is often simpler to create the review request through `WorkItemService` directly, as shown above.
- Browser automation using the system Firefox wrapper may fail on some machines because the wrapper delegates through Snap and DBus.
- If that happens, use the real Firefox binary directly instead of the wrapper.

## Suggested Post-Smoke Cleanup

If you want to remove the smoke dataset:

```bash
docker compose exec -T postgres psql -U gooseherd -d gooseherd -c "
delete from review_request_comments where review_request_id in (select id from review_requests where work_item_id in (select id from work_items where title like 'Smoke%'));
delete from review_requests where work_item_id in (select id from work_items where title like 'Smoke%');
delete from work_item_events where work_item_id in (select id from work_items where title like 'Smoke%');
delete from work_items where title like 'Smoke%';
delete from team_members where team_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
delete from teams where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
delete from users where id in (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333'
);
"
```
