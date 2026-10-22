CREATE TYPE "public"."property_kind" AS ENUM('text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'person', 'relation', 'url');--> statement-breakpoint
CREATE TYPE "public"."domain_event_type" AS ENUM('page.created', 'page.updated', 'block.updated', 'database.row.created', 'database.row.updated');--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider_subject_uq" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"inviter_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_role_ck" CHECK ("workspace_invitations"."role" is null or "workspace_invitations"."role" in ('owner','admin','member','guest'))
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mfa_deadline" timestamp with time zone,
	CONSTRAINT "members_workspace_user_uq" UNIQUE("workspace_id","user_id"),
	CONSTRAINT "members_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "members_role_ck" CHECK ("workspace_members"."role" in ('owner','admin','member','guest'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "auth_passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" bigint NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"aaguid" text,
	CONSTRAINT "auth_passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "auth_rate_limits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"active_workspace_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "session_assurance" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "assurance_method_ck" CHECK ("session_assurance"."method" in ('totp','passkey','recovery'))
);
--> statement-breakpoint
CREATE TABLE "auth_two_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "auth_two_factors_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "auth_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"anonymized_at" timestamp with time zone,
	CONSTRAINT "actors_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "actors_kind_ck" CHECK ("actors"."kind" in ('user','api_key','system','anonymized'))
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"page_id" uuid NOT NULL,
	"parent_id" uuid,
	"position" varchar(128) COLLATE "C" NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"content" jsonb NOT NULL,
	CONSTRAINT "blocks_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "blocks_workspace_page_id_uq" UNIQUE("workspace_id","page_id","id"),
	CONSTRAINT "blocks_not_self_ck" CHECK ("blocks"."parent_id" is distinct from "blocks"."id"),
	CONSTRAINT "blocks_rank_ck" CHECK ("blocks"."position" ~ '^[0-9A-Za-z]+$'),
	CONSTRAINT "blocks_version_ck" CHECK ("blocks"."schema_version" > 0),
	CONSTRAINT "blocks_type_ck" CHECK ("blocks"."type" ~ '^[a-z][a-z0-9-]*[.][a-z][a-z0-9-]*$'),
	CONSTRAINT "blocks_content_ck" CHECK (jsonb_typeof("blocks"."content") = 'object'),
	CONSTRAINT "blocks_non_nil_ck" CHECK ("blocks"."id" <> '00000000-0000-0000-0000-000000000000'::uuid)
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"parent_id" uuid,
	"title" text DEFAULT '' NOT NULL,
	"icon" text,
	"position" varchar(128) COLLATE "C" NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "pages_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "pages_not_self_ck" CHECK ("pages"."parent_id" is distinct from "pages"."id"),
	CONSTRAINT "pages_rank_ck" CHECK ("pages"."position" ~ '^[0-9A-Za-z]+$'),
	CONSTRAINT "pages_version_ck" CHECK ("pages"."version" between 1 and 9007199254740991),
	CONSTRAINT "pages_non_nil_ck" CHECK ("pages"."id" <> '00000000-0000-0000-0000-000000000000'::uuid)
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"workspace_id" uuid NOT NULL,
	"page_id" uuid PRIMARY KEY NOT NULL,
	"plain_text" text NOT NULL,
	"page_version" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, plain_text)) STORED
);
--> statement-breakpoint
CREATE TABLE "access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"subject_id" uuid NOT NULL,
	"resource_type" text DEFAULT 'page' NOT NULL,
	"resource_id" uuid NOT NULL,
	"level" text NOT NULL,
	"inherit" boolean DEFAULT true NOT NULL,
	CONSTRAINT "grants_resource_ck" CHECK ("access_grants"."resource_type" = 'page'),
	CONSTRAINT "grants_level_ck" CHECK ("access_grants"."level" in ('read','edit'))
);
--> statement-breakpoint
CREATE TABLE "access_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"kind" text NOT NULL,
	"member_id" uuid,
	"api_key_policy_id" uuid,
	CONSTRAINT "subjects_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "subjects_member_uq" UNIQUE("workspace_id","member_id"),
	CONSTRAINT "subjects_key_uq" UNIQUE("workspace_id","api_key_policy_id"),
	CONSTRAINT "subjects_kind_ck" CHECK (("access_subjects"."kind" = 'member' and "access_subjects"."member_id" is not null and "access_subjects"."api_key_policy_id" is null) or ("access_subjects"."kind" = 'api_key' and "access_subjects"."api_key_policy_id" is not null and "access_subjects"."member_id" is null))
);
--> statement-breakpoint
CREATE TABLE "api_key_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"credential_id" uuid,
	"actor_id" uuid NOT NULL,
	"issuer_member_id" uuid,
	"revoked_at" timestamp with time zone,
	"display_prefix" text NOT NULL,
	CONSTRAINT "api_key_policies_credential_id_unique" UNIQUE("credential_id"),
	CONSTRAINT "key_policies_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "key_policies_actor_uq" UNIQUE("workspace_id","actor_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"config_id" text DEFAULT 'public-v1' NOT NULL,
	"name" text,
	"start" text,
	"prefix" text,
	"key_hash" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_time_window" integer DEFAULT 60000,
	"rate_limit_max" integer DEFAULT 120,
	"request_count" integer DEFAULT 0 NOT NULL,
	"remaining" integer,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"permissions" text,
	"metadata" text,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "workspace_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"require_strong_auth" boolean DEFAULT false NOT NULL,
	"strong_auth_enabled_at" timestamp with time zone,
	"grace_days" integer DEFAULT 7 NOT NULL,
	"trash_retention_days" integer DEFAULT 30 NOT NULL,
	"event_retention_days" integer DEFAULT 30 NOT NULL,
	"delivery_retention_days" integer DEFAULT 30 NOT NULL,
	"audit_retention_days" integer DEFAULT 90 NOT NULL,
	CONSTRAINT "policies_workspace_uq" UNIQUE("workspace_id"),
	CONSTRAINT "policies_retention_ck" CHECK ("workspace_policies"."grace_days" >= 0 and "workspace_policies"."trash_retention_days" > 0 and "workspace_policies"."event_retention_days" > 0 and "workspace_policies"."delivery_retention_days" > 0 and "workspace_policies"."audit_retention_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "database_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"database_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" "property_kind" NOT NULL,
	"position" varchar(128) COLLATE "C" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"relation_target_database_id" uuid,
	CONSTRAINT "properties_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "properties_typed_uq" UNIQUE("workspace_id","database_id","id","kind"),
	CONSTRAINT "properties_relation_target_uq" UNIQUE("workspace_id","database_id","id","relation_target_database_id"),
	CONSTRAINT "properties_relation_ck" CHECK (("database_properties"."kind" = 'relation') = ("database_properties"."relation_target_database_id" is not null)),
	CONSTRAINT "properties_config_ck" CHECK (jsonb_typeof("database_properties"."config") = 'object')
);
--> statement-breakpoint
CREATE TABLE "database_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"database_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	CONSTRAINT "rows_page_uq" UNIQUE("workspace_id","page_id"),
	CONSTRAINT "rows_database_page_uq" UNIQUE("workspace_id","database_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "database_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"database_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'table' NOT NULL,
	"position" varchar(128) COLLATE "C" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "views_type_ck" CHECK ("database_views"."type" = 'table'),
	CONSTRAINT "views_config_ck" CHECK (jsonb_typeof("database_views"."config") = 'object')
);
--> statement-breakpoint
CREATE TABLE "databases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"page_id" uuid NOT NULL,
	CONSTRAINT "databases_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "databases_page_uq" UNIQUE("workspace_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "multi_select_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"database_id" uuid NOT NULL,
	"row_page_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" "property_kind" NOT NULL,
	"option_id" uuid NOT NULL,
	CONSTRAINT "multi_select_kind_ck" CHECK ("multi_select_values"."kind" = 'multi_select')
);
--> statement-breakpoint
CREATE TABLE "person_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"database_id" uuid NOT NULL,
	"row_page_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" "property_kind" NOT NULL,
	"member_id" uuid NOT NULL,
	CONSTRAINT "person_values_kind_ck" CHECK ("person_values"."kind" = 'person')
);
--> statement-breakpoint
CREATE TABLE "property_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"database_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" "property_kind" NOT NULL,
	"label" text NOT NULL,
	"color" text,
	"position" varchar(128) COLLATE "C" NOT NULL,
	CONSTRAINT "options_property_id_uq" UNIQUE("workspace_id","property_id","id"),
	CONSTRAINT "options_kind_ck" CHECK ("property_options"."kind" in ('select','multi_select'))
);
--> statement-breakpoint
CREATE TABLE "property_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"database_id" uuid NOT NULL,
	"row_page_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" "property_kind" NOT NULL,
	"text_value" text,
	"number_value" numeric(28, 8),
	"boolean_value" boolean,
	"option_id" uuid,
	"date_start" date,
	"date_end" date,
	"date_time_start" timestamp with time zone,
	"date_time_end" timestamp with time zone,
	"time_zone" text,
	CONSTRAINT "values_scalar_shape_ck" CHECK (
    ("property_values"."kind" in ('text','url') and "property_values"."text_value" is not null and num_nonnulls("property_values"."number_value", "property_values"."boolean_value", "property_values"."option_id", "property_values"."date_start", "property_values"."date_time_start") = 0)
    or ("property_values"."kind" = 'number' and "property_values"."number_value" is not null and num_nonnulls("property_values"."text_value", "property_values"."boolean_value", "property_values"."option_id", "property_values"."date_start", "property_values"."date_time_start") = 0)
    or ("property_values"."kind" = 'checkbox' and "property_values"."boolean_value" is not null and num_nonnulls("property_values"."text_value", "property_values"."number_value", "property_values"."option_id", "property_values"."date_start", "property_values"."date_time_start") = 0)
    or ("property_values"."kind" = 'select' and "property_values"."option_id" is not null and num_nonnulls("property_values"."text_value", "property_values"."number_value", "property_values"."boolean_value", "property_values"."date_start", "property_values"."date_time_start") = 0)
    or ("property_values"."kind" = 'date' and num_nonnulls("property_values"."date_start", "property_values"."date_time_start") = 1 and num_nonnulls("property_values"."text_value", "property_values"."number_value", "property_values"."boolean_value", "property_values"."option_id") = 0)),
	CONSTRAINT "values_date_shape_ck" CHECK (("property_values"."date_end" is null or ("property_values"."date_start" is not null and "property_values"."date_end" >= "property_values"."date_start")) and ("property_values"."date_time_end" is null or ("property_values"."date_time_start" is not null and "property_values"."date_time_end" >= "property_values"."date_time_start")) and ("property_values"."time_zone" is null or "property_values"."date_time_start" is not null))
);
--> statement-breakpoint
CREATE TABLE "relation_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"database_id" uuid NOT NULL,
	"row_page_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" "property_kind" NOT NULL,
	"target_database_id" uuid NOT NULL,
	"target_page_id" uuid NOT NULL,
	CONSTRAINT "relations_kind_ck" CHECK ("relation_values"."kind" = 'relation')
);
--> statement-breakpoint
CREATE TABLE "file_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"file_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"block_id" uuid
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"object_key" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"upload_expires_at" timestamp with time zone,
	CONSTRAINT "files_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "files_object_key_uq" UNIQUE("object_key"),
	CONSTRAINT "files_size_ck" CHECK ("files"."byte_size" between 0 and 9007199254740991),
	CONSTRAINT "files_state_ck" CHECK ("files"."state" in ('pending','ready','deleting'))
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"route" text NOT NULL,
	"key_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_ciphertext" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_scope_uq" UNIQUE("workspace_id","actor_id","route","key_hash"),
	CONSTRAINT "idempotency_status_ck" CHECK ("idempotency_records"."status" in ('in_progress','completed'))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "domain_event_type" NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"actor_id" uuid,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_until" timestamp with time zone,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "outbox_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "webhook_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"http_status" integer,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	CONSTRAINT "attempt_number_uq" UNIQUE("delivery_id","attempt_number")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "deliveries_event_endpoint_uq" UNIQUE("workspace_id","event_id","endpoint_id"),
	CONSTRAINT "deliveries_status_ck" CHECK ("webhook_deliveries"."status" in ('pending','delivering','succeeded','exhausted','canceled'))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"url" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"events" "domain_event_type"[] NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_key_version" integer DEFAULT 1 NOT NULL,
	"previous_secret_ciphertext" text,
	"previous_secret_expires_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "webhooks_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "webhooks_events_ck" CHECK (cardinality("webhook_endpoints"."events") > 0)
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_inviter_id_auth_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_passkeys" ADD CONSTRAINT "auth_passkeys_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_active_workspace_id_workspaces_id_fk" FOREIGN KEY ("active_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_assurance" ADD CONSTRAINT "session_assurance_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_two_factors" ADD CONSTRAINT "auth_two_factors_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actors" ADD CONSTRAINT "actors_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_workspace_id_page_id_pages_workspace_id_id_fk" FOREIGN KEY ("workspace_id","page_id") REFERENCES "public"."pages"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_workspace_id_page_id_parent_id_blocks_workspace_id_page_id_id_fk" FOREIGN KEY ("workspace_id","page_id","parent_id") REFERENCES "public"."blocks"("workspace_id","page_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_workspace_id_parent_id_pages_workspace_id_id_fk" FOREIGN KEY ("workspace_id","parent_id") REFERENCES "public"."pages"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_workspace_id_page_id_pages_workspace_id_id_fk" FOREIGN KEY ("workspace_id","page_id") REFERENCES "public"."pages"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_workspace_id_subject_id_access_subjects_workspace_id_id_fk" FOREIGN KEY ("workspace_id","subject_id") REFERENCES "public"."access_subjects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_workspace_id_resource_id_pages_workspace_id_id_fk" FOREIGN KEY ("workspace_id","resource_id") REFERENCES "public"."pages"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_subjects" ADD CONSTRAINT "access_subjects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_subjects" ADD CONSTRAINT "access_subjects_workspace_id_member_id_workspace_members_workspace_id_id_fk" FOREIGN KEY ("workspace_id","member_id") REFERENCES "public"."workspace_members"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_subjects" ADD CONSTRAINT "access_subjects_workspace_id_api_key_policy_id_api_key_policies_workspace_id_id_fk" FOREIGN KEY ("workspace_id","api_key_policy_id") REFERENCES "public"."api_key_policies"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_subjects" ADD CONSTRAINT "access_subjects_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_subjects" ADD CONSTRAINT "access_subjects_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_policies" ADD CONSTRAINT "api_key_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_policies" ADD CONSTRAINT "api_key_policies_credential_id_api_keys_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_policies" ADD CONSTRAINT "api_key_policies_workspace_id_actor_id_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_policies" ADD CONSTRAINT "api_key_policies_workspace_id_issuer_member_id_workspace_members_workspace_id_id_fk" FOREIGN KEY ("workspace_id","issuer_member_id") REFERENCES "public"."workspace_members"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_policies" ADD CONSTRAINT "api_key_policies_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_policies" ADD CONSTRAINT "api_key_policies_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_policies" ADD CONSTRAINT "workspace_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_policies" ADD CONSTRAINT "workspace_policies_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_policies" ADD CONSTRAINT "workspace_policies_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_properties" ADD CONSTRAINT "database_properties_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_properties" ADD CONSTRAINT "database_properties_workspace_id_database_id_databases_workspace_id_id_fk" FOREIGN KEY ("workspace_id","database_id") REFERENCES "public"."databases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_properties" ADD CONSTRAINT "database_properties_workspace_id_relation_target_database_id_databases_workspace_id_id_fk" FOREIGN KEY ("workspace_id","relation_target_database_id") REFERENCES "public"."databases"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_properties" ADD CONSTRAINT "database_properties_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_properties" ADD CONSTRAINT "database_properties_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_workspace_id_database_id_databases_workspace_id_id_fk" FOREIGN KEY ("workspace_id","database_id") REFERENCES "public"."databases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_workspace_id_page_id_pages_workspace_id_id_fk" FOREIGN KEY ("workspace_id","page_id") REFERENCES "public"."pages"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_rows" ADD CONSTRAINT "database_rows_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_views" ADD CONSTRAINT "database_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_views" ADD CONSTRAINT "database_views_workspace_id_database_id_databases_workspace_id_id_fk" FOREIGN KEY ("workspace_id","database_id") REFERENCES "public"."databases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_views" ADD CONSTRAINT "database_views_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_views" ADD CONSTRAINT "database_views_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_workspace_id_page_id_pages_workspace_id_id_fk" FOREIGN KEY ("workspace_id","page_id") REFERENCES "public"."pages"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_select_values" ADD CONSTRAINT "multi_select_values_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_select_values" ADD CONSTRAINT "multi_select_values_workspace_id_database_id_row_page_id_database_rows_workspace_id_database_id_page_id_fk" FOREIGN KEY ("workspace_id","database_id","row_page_id") REFERENCES "public"."database_rows"("workspace_id","database_id","page_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_select_values" ADD CONSTRAINT "multi_select_values_workspace_id_database_id_property_id_kind_database_properties_workspace_id_database_id_id_kind_fk" FOREIGN KEY ("workspace_id","database_id","property_id","kind") REFERENCES "public"."database_properties"("workspace_id","database_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_select_values" ADD CONSTRAINT "multi_select_values_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_select_values" ADD CONSTRAINT "multi_select_values_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "multi_select_values" ADD CONSTRAINT "multi_select_values_workspace_id_property_id_option_id_property_options_workspace_id_property_id_id_fk" FOREIGN KEY ("workspace_id","property_id","option_id") REFERENCES "public"."property_options"("workspace_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_values" ADD CONSTRAINT "person_values_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_values" ADD CONSTRAINT "person_values_workspace_id_database_id_row_page_id_database_rows_workspace_id_database_id_page_id_fk" FOREIGN KEY ("workspace_id","database_id","row_page_id") REFERENCES "public"."database_rows"("workspace_id","database_id","page_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_values" ADD CONSTRAINT "person_values_workspace_id_database_id_property_id_kind_database_properties_workspace_id_database_id_id_kind_fk" FOREIGN KEY ("workspace_id","database_id","property_id","kind") REFERENCES "public"."database_properties"("workspace_id","database_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_values" ADD CONSTRAINT "person_values_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_values" ADD CONSTRAINT "person_values_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_values" ADD CONSTRAINT "person_values_workspace_id_member_id_workspace_members_workspace_id_id_fk" FOREIGN KEY ("workspace_id","member_id") REFERENCES "public"."workspace_members"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_options" ADD CONSTRAINT "property_options_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_options" ADD CONSTRAINT "property_options_workspace_id_database_id_property_id_kind_database_properties_workspace_id_database_id_id_kind_fk" FOREIGN KEY ("workspace_id","database_id","property_id","kind") REFERENCES "public"."database_properties"("workspace_id","database_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_options" ADD CONSTRAINT "property_options_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_options" ADD CONSTRAINT "property_options_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_values" ADD CONSTRAINT "property_values_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_values" ADD CONSTRAINT "property_values_workspace_id_database_id_row_page_id_database_rows_workspace_id_database_id_page_id_fk" FOREIGN KEY ("workspace_id","database_id","row_page_id") REFERENCES "public"."database_rows"("workspace_id","database_id","page_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_values" ADD CONSTRAINT "property_values_workspace_id_database_id_property_id_kind_database_properties_workspace_id_database_id_id_kind_fk" FOREIGN KEY ("workspace_id","database_id","property_id","kind") REFERENCES "public"."database_properties"("workspace_id","database_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_values" ADD CONSTRAINT "property_values_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_values" ADD CONSTRAINT "property_values_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_values" ADD CONSTRAINT "property_values_workspace_id_property_id_option_id_property_options_workspace_id_property_id_id_fk" FOREIGN KEY ("workspace_id","property_id","option_id") REFERENCES "public"."property_options"("workspace_id","property_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_values" ADD CONSTRAINT "relation_values_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_values" ADD CONSTRAINT "relation_values_workspace_id_database_id_row_page_id_database_rows_workspace_id_database_id_page_id_fk" FOREIGN KEY ("workspace_id","database_id","row_page_id") REFERENCES "public"."database_rows"("workspace_id","database_id","page_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_values" ADD CONSTRAINT "relation_values_workspace_id_database_id_property_id_kind_database_properties_workspace_id_database_id_id_kind_fk" FOREIGN KEY ("workspace_id","database_id","property_id","kind") REFERENCES "public"."database_properties"("workspace_id","database_id","id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_values" ADD CONSTRAINT "relation_values_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_values" ADD CONSTRAINT "relation_values_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_values" ADD CONSTRAINT "relation_values_workspace_id_database_id_property_id_target_database_id_database_properties_workspace_id_database_id_id_relation_target_database_id_fk" FOREIGN KEY ("workspace_id","database_id","property_id","target_database_id") REFERENCES "public"."database_properties"("workspace_id","database_id","id","relation_target_database_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_values" ADD CONSTRAINT "relation_values_workspace_id_target_database_id_target_page_id_database_rows_workspace_id_database_id_page_id_fk" FOREIGN KEY ("workspace_id","target_database_id","target_page_id") REFERENCES "public"."database_rows"("workspace_id","database_id","page_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_workspace_id_file_id_files_workspace_id_id_fk" FOREIGN KEY ("workspace_id","file_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_workspace_id_page_id_pages_workspace_id_id_fk" FOREIGN KEY ("workspace_id","page_id") REFERENCES "public"."pages"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_workspace_id_page_id_block_id_blocks_workspace_id_page_id_id_fk" FOREIGN KEY ("workspace_id","page_id","block_id") REFERENCES "public"."blocks"("workspace_id","page_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_actor_id_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_workspace_id_actor_id_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_actor_id_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_workspace_id_delivery_id_webhook_deliveries_workspace_id_id_fk" FOREIGN KEY ("workspace_id","delivery_id") REFERENCES "public"."webhook_deliveries"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_endpoint_id_webhook_endpoints_workspace_id_id_fk" FOREIGN KEY ("workspace_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_event_id_outbox_events_workspace_id_id_fk" FOREIGN KEY ("workspace_id","event_id") REFERENCES "public"."outbox_events"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_created_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_updated_by_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitations_workspace_idx" ON "workspace_invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "workspace_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "invitations_expiry_idx" ON "workspace_invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "auth_passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_normalized_uq" ON "auth_users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verifications_expiry_idx" ON "auth_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "blocks_sibling_position_uq" ON "blocks" USING btree ("workspace_id","page_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),"position") WHERE "blocks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "blocks_page_idx" ON "blocks" USING btree ("workspace_id","page_id");--> statement-breakpoint
CREATE INDEX "blocks_trash_idx" ON "blocks" USING btree ("deleted_at") WHERE "blocks"."deleted_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pages_sibling_position_uq" ON "pages" USING btree ("workspace_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),"position") WHERE "pages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "pages_parent_idx" ON "pages" USING btree ("workspace_id","parent_id");--> statement-breakpoint
CREATE INDEX "pages_trash_idx" ON "pages" USING btree ("deleted_at") WHERE "pages"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "search_workspace_idx" ON "search_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "search_vector_idx" ON "search_documents" USING gin ("vector");--> statement-breakpoint
CREATE UNIQUE INDEX "grants_live_uq" ON "access_grants" USING btree ("workspace_id","subject_id","resource_type","resource_id") WHERE "access_grants"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "grants_resource_idx" ON "access_grants" USING btree ("workspace_id","resource_id");--> statement-breakpoint
CREATE INDEX "api_keys_workspace_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "properties_live_key_uq" ON "database_properties" USING btree ("workspace_id","database_id","key") WHERE "database_properties"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "multi_select_live_uq" ON "multi_select_values" USING btree ("workspace_id","row_page_id","property_id","option_id") WHERE "multi_select_values"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "multi_select_filter_idx" ON "multi_select_values" USING btree ("workspace_id","property_id","option_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_values_live_uq" ON "person_values" USING btree ("workspace_id","row_page_id","property_id","member_id") WHERE "person_values"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "person_values_filter_idx" ON "person_values" USING btree ("workspace_id","property_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "values_live_cell_uq" ON "property_values" USING btree ("workspace_id","row_page_id","property_id") WHERE "property_values"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "values_text_sort_idx" ON "property_values" USING btree ("workspace_id","property_id","text_value","row_page_id") WHERE "property_values"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "values_number_sort_idx" ON "property_values" USING btree ("workspace_id","property_id","number_value","row_page_id") WHERE "property_values"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "values_date_sort_idx" ON "property_values" USING btree ("workspace_id","property_id","date_start","row_page_id") WHERE "property_values"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "values_datetime_sort_idx" ON "property_values" USING btree ("workspace_id","property_id","date_time_start","row_page_id") WHERE "property_values"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "relations_live_uq" ON "relation_values" USING btree ("workspace_id","row_page_id","property_id","target_page_id") WHERE "relation_values"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "relations_reverse_idx" ON "relation_values" USING btree ("workspace_id","target_page_id","property_id");--> statement-breakpoint
CREATE INDEX "file_refs_page_idx" ON "file_references" USING btree ("workspace_id","page_id");--> statement-breakpoint
CREATE INDEX "file_refs_file_idx" ON "file_references" USING btree ("workspace_id","file_id");--> statement-breakpoint
CREATE INDEX "files_cleanup_idx" ON "files" USING btree ("state","upload_expires_at");--> statement-breakpoint
CREATE INDEX "audit_workspace_time_idx" ON "audit_logs" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idempotency_expiry_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("available_at","created_at") WHERE "outbox_events"."published_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_retention_idx" ON "outbox_events" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");