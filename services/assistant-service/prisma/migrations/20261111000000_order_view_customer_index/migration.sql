-- CreateIndex
CREATE INDEX "order_view_customer_id_last_event_at_idx" ON "order_view"("customer_id", "last_event_at");
