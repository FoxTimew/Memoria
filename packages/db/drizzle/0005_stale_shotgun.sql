CREATE TABLE "collaboration_block_ids" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collaboration_block_ids" ADD CONSTRAINT "collaboration_block_ids_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collab_block_ids_page_idx" ON "collaboration_block_ids" USING btree ("page_id");