CREATE TABLE "database_assignable_people" (
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	CONSTRAINT "database_assignable_people_workspace_id_database_id_person_id_pk" PRIMARY KEY("workspace_id","database_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "database_row_changes" (
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"row_page_id" uuid NOT NULL,
	"property_revision" bigint DEFAULT 0 NOT NULL,
	"first_dirty_at" timestamp with time zone,
	"last_dirty_at" timestamp with time zone,
	CONSTRAINT "database_row_changes_workspace_id_row_page_id_pk" PRIMARY KEY("workspace_id","row_page_id"),
	CONSTRAINT "row_property_revision_ck" CHECK ("database_row_changes"."property_revision">=0)
);
--> statement-breakpoint
ALTER TABLE "database_assignable_people" ADD CONSTRAINT "database_assignable_people_workspace_id_database_id_databases_workspace_id_id_fk" FOREIGN KEY ("workspace_id","database_id") REFERENCES "public"."databases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_assignable_people" ADD CONSTRAINT "database_assignable_people_workspace_id_person_id_database_people_workspace_id_id_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."database_people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_row_changes" ADD CONSTRAINT "database_row_changes_workspace_id_database_id_row_page_id_database_rows_workspace_id_database_id_page_id_fk" FOREIGN KEY ("workspace_id","database_id","row_page_id") REFERENCES "public"."database_rows"("workspace_id","database_id","page_id") ON DELETE cascade ON UPDATE no action;