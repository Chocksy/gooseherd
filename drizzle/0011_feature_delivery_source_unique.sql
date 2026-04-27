CREATE UNIQUE INDEX "work_items_feature_delivery_source_work_item_id_idx"
  ON "work_items" USING btree ("source_work_item_id")
  WHERE "source_work_item_id" IS NOT NULL AND "workflow" = 'feature_delivery';
