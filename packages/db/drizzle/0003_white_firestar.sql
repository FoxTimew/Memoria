CREATE TABLE "collaboration_documents" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"snapshot" "bytea" NOT NULL,
	"snapshot_revision" bigint DEFAULT 0 NOT NULL,
	"content_revision" bigint DEFAULT 0 NOT NULL,
	"projection_revision" bigint DEFAULT 0 NOT NULL,
	"journal_bytes" bigint DEFAULT 0 NOT NULL,
	"projection_first_pending_at" timestamp with time zone,
	"projection_due_at" timestamp with time zone,
	"projection_retry_at" timestamp with time zone,
	"projection_attempts" integer DEFAULT 0 NOT NULL,
	"encoded_bytes" integer NOT NULL,
	"business_bytes" integer NOT NULL,
	"metrics_revision" bigint DEFAULT 0 NOT NULL,
	"history_ratio" numeric GENERATED ALWAYS AS (encoded_bytes::numeric / greatest(business_bytes, 1)) STORED,
	"history_warning_at" timestamp with time zone,
	"compacted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collab_document_scope_uq" UNIQUE("workspace_id","page_id","generation"),
	CONSTRAINT "collab_snapshot_size_ck" CHECK (octet_length("collaboration_documents"."snapshot") between 2 and 1048576),
	CONSTRAINT "collab_revisions_ck" CHECK ("collaboration_documents"."snapshot_revision" >= 0 and "collaboration_documents"."projection_revision" >= 0 and "collaboration_documents"."metrics_revision" >= 0 and "collaboration_documents"."content_revision" between greatest("collaboration_documents"."snapshot_revision","collaboration_documents"."projection_revision","collaboration_documents"."metrics_revision") and 9007199254740991),
	CONSTRAINT "collab_sizes_ck" CHECK ("collaboration_documents"."encoded_bytes" between 2 and 1048576 and "collaboration_documents"."business_bytes" between 2 and 1048576 and "collaboration_documents"."journal_bytes" >= 0 and "collaboration_documents"."projection_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "collaboration_leadership" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"owner" uuid NOT NULL,
	"epoch" bigint NOT NULL,
	"backend_pid" integer NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	CONSTRAINT "collab_leader_singleton_ck" CHECK ("collaboration_leadership"."id"=1 and "collaboration_leadership"."epoch">0)
);
--> statement-breakpoint
CREATE TABLE "collaboration_nonces" (
	"nonce" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collaboration_projection_commits" (
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb NOT NULL,
	CONSTRAINT "collaboration_projection_commits_page_id_generation_revision_pk" PRIMARY KEY("page_id","generation","revision")
);
--> statement-breakpoint
CREATE TABLE "collaboration_receipts" (
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"receipt" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"update_hash" text NOT NULL,
	"request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collaboration_receipts_page_id_generation_actor_id_receipt_pk" PRIMARY KEY("page_id","generation","actor_id","receipt"),
	CONSTRAINT "collab_receipt_hash_ck" CHECK ("collaboration_receipts"."update_hash" ~ '^[a-f0-9]{64}$' and ("collaboration_receipts"."request_hash" is null or "collaboration_receipts"."request_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "collab_receipt_revision_ck" CHECK ("collaboration_receipts"."revision" between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "collaboration_updates" (
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"update" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collaboration_updates_page_id_generation_revision_pk" PRIMARY KEY("page_id","generation","revision"),
	CONSTRAINT "collab_update_size_ck" CHECK (octet_length("collaboration_updates"."update") between 2 and 1048576),
	CONSTRAINT "collab_update_revision_ck" CHECK ("collaboration_updates"."revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "collaboration_documents" ADD CONSTRAINT "collaboration_documents_workspace_id_page_id_pages_workspace_id_id_fk" FOREIGN KEY ("workspace_id","page_id") REFERENCES "public"."pages"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_projection_commits" ADD CONSTRAINT "collaboration_projection_commits_workspace_id_page_id_generation_collaboration_documents_workspace_id_page_id_generation_fk" FOREIGN KEY ("workspace_id","page_id","generation") REFERENCES "public"."collaboration_documents"("workspace_id","page_id","generation") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_receipts" ADD CONSTRAINT "collaboration_receipts_workspace_id_page_id_generation_collaboration_documents_workspace_id_page_id_generation_fk" FOREIGN KEY ("workspace_id","page_id","generation") REFERENCES "public"."collaboration_documents"("workspace_id","page_id","generation") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_receipts" ADD CONSTRAINT "collaboration_receipts_workspace_id_actor_id_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."actors"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_updates" ADD CONSTRAINT "collaboration_updates_workspace_id_page_id_generation_collaboration_documents_workspace_id_page_id_generation_fk" FOREIGN KEY ("workspace_id","page_id","generation") REFERENCES "public"."collaboration_documents"("workspace_id","page_id","generation") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collab_projection_due_idx" ON "collaboration_documents" USING btree ("projection_due_at") WHERE "collaboration_documents"."projection_due_at" is not null;--> statement-breakpoint
CREATE INDEX "collab_nonce_expiry_idx" ON "collaboration_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "collab_receipt_revision_idx" ON "collaboration_receipts" USING btree ("page_id","generation","revision");