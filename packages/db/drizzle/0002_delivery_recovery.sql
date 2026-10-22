ALTER TABLE "outbox_events" ADD COLUMN "materialized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "claimed_until" timestamp with time zone;