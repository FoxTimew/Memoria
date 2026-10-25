CREATE TABLE "auth_mail_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"kind" text NOT NULL,
	"payload" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_mail_kind_ck" CHECK ("auth_mail_jobs"."kind" in ('password-request','delivery'))
);
--> statement-breakpoint
CREATE TABLE "auth_operator_recovery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"security_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "auth_operator_recovery_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
ALTER TABLE "account_security" ADD COLUMN "recovery_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_security_events" ADD COLUMN "operator" text;--> statement-breakpoint
ALTER TABLE "auth_security_events" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "auth_security_events" ADD COLUMN "target" text;--> statement-breakpoint
ALTER TABLE "session_security" ADD COLUMN "recovery_factor_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_mail_jobs" ADD CONSTRAINT "auth_mail_jobs_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_operator_recovery" ADD CONSTRAINT "auth_operator_recovery_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_mail_available_idx" ON "auth_mail_jobs" USING btree ("available_at");