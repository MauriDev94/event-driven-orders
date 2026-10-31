-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'confirmed', 'rejected');

-- CreateEnum
CREATE TYPE "StockResult" AS ENUM ('reserved', 'rejected');

-- CreateTable
CREATE TABLE "order_event_log" (
    "event_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_event_log_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "order_view" (
    "order_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "status" "OrderStatus" NOT NULL,
    "stock_result" "StockResult",
    "rejection_reason" TEXT,
    "total_amount" DECIMAL(14,2),
    "items" JSONB,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "last_event_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_view_pkey" PRIMARY KEY ("order_id")
);

-- CreateIndex
CREATE INDEX "order_event_log_order_id_occurred_at_idx" ON "order_event_log"("order_id", "occurred_at");

