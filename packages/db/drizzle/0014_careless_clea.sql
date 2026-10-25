CREATE TABLE "auth_attempt_accounts" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_attempt_leases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"account_key" text NOT NULL,
	"lane" text NOT NULL,
	"generation" integer NOT NULL,
	"ready_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"touched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_recovery_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_key" text NOT NULL,
	"purpose" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_recovery_challenges_attempts_ck" CHECK ("auth_recovery_challenges"."attempts" between 0 and 5)
);
--> statement-breakpoint
ALTER TABLE "auth_mail_jobs" DROP CONSTRAINT "auth_mail_kind_ck";--> statement-breakpoint
CREATE INDEX "auth_accounts_cleanup_idx" ON "auth_attempt_accounts" USING btree ("touched_at");--> statement-breakpoint
CREATE INDEX "auth_leases_account_idx" ON "auth_attempt_leases" USING btree ("account_key");--> statement-breakpoint
CREATE INDEX "auth_leases_expiry_idx" ON "auth_attempt_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_buckets_cleanup_idx" ON "auth_buckets" USING btree ("touched_at");--> statement-breakpoint
CREATE INDEX "auth_recovery_challenges_expiry_idx" ON "auth_recovery_challenges" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "auth_mail_jobs" ADD CONSTRAINT "auth_mail_kind_ck" CHECK ("auth_mail_jobs"."kind" in ('password-request','verification-request','delivery'));