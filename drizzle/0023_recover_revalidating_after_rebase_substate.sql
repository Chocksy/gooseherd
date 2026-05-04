UPDATE "work_items"
SET "substate" = 'ci_failed'
WHERE "workflow" = 'feature_delivery'
  AND "state" = 'auto_review'
  AND "substate" = 'revalidating_after_rebase';
