CREATE TABLE "account_security" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"last_totp_step" bigint DEFAULT -1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_factor_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "factor_challenge_attempts_ck" CHECK ("auth_factor_challenges"."attempts" between 0 and 5),
	CONSTRAINT "factor_challenge_purpose_ck" CHECK ("auth_factor_challenges"."purpose" in ('totp-enroll','totp-auth'))
);
--> statement-breakpoint
CREATE TABLE "auth_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "auth_recovery_codes_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "session_security" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"password_verified_at" timestamp with time zone,
	"shared_computer" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_assurance" ADD COLUMN "security_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_assurance" ADD COLUMN "factor_id" uuid;--> statement-breakpoint
ALTER TABLE "account_security" ADD CONSTRAINT "account_security_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_security_events" ADD CONSTRAINT "auth_security_events_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_factor_challenges" ADD CONSTRAINT "auth_factor_challenges_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_factor_challenges" ADD CONSTRAINT "auth_factor_challenges_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_recovery_codes" ADD CONSTRAINT "auth_recovery_codes_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_security" ADD CONSTRAINT "session_security_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_security_events_created_idx" ON "auth_security_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "factor_challenges_session_idx" ON "auth_factor_challenges" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "auth_recovery_codes" USING btree ("user_id");