CREATE TABLE "database_counters" (
	"workspace_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "database_counters_workspace_id_scope_resource_id_pk" PRIMARY KEY("workspace_id","scope","resource_id")
);
--> statement-breakpoint
CREATE TABLE "database_create_receipts" (
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"receipt" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"row_page_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "database_create_receipts_workspace_id_database_id_actor_id_receipt_pk" PRIMARY KEY("workspace_id","database_id","actor_id","receipt")
);
--> statement-breakpoint
CREATE TABLE "database_row_authors" (
	"workspace_id" uuid NOT NULL,
	"row_page_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	CONSTRAINT "database_row_authors_workspace_id_row_page_id_actor_id_pk" PRIMARY KEY("workspace_id","row_page_id","actor_id")
);
--> statement-breakpoint
CREATE TABLE "database_row_search" (
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"row_page_id" uuid NOT NULL,
	"relational_text" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple',relational_text || '
' || body_text)) STORED,
	CONSTRAINT "database_row_search_workspace_id_row_page_id_pk" PRIMARY KEY("workspace_id","row_page_id")
);
--> statement-breakpoint
ALTER TABLE "database_row_changes" ADD COLUMN "event_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "database_counters" ADD CONSTRAINT "database_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_create_receipts" ADD CONSTRAINT "database_create_receipts_workspace_id_database_id_row_page_id_database_rows_workspace_id_database_id_page_id_fk" FOREIGN KEY ("workspace_id","database_id","row_page_id") REFERENCES "public"."database_rows"("workspace_id","database_id","page_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_row_authors" ADD CONSTRAINT "database_row_authors_workspace_id_row_page_id_database_rows_workspace_id_page_id_fk" FOREIGN KEY ("workspace_id","row_page_id") REFERENCES "public"."database_rows"("workspace_id","page_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_row_search" ADD CONSTRAINT "database_row_search_workspace_id_database_id_row_page_id_database_rows_workspace_id_database_id_page_id_fk" FOREIGN KEY ("workspace_id","database_id","row_page_id") REFERENCES "public"."database_rows"("workspace_id","database_id","page_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_create_receipts_expiry_idx" ON "database_create_receipts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "database_row_search_vector_idx" ON "database_row_search" USING gin ("vector");
--> statement-breakpoint
-- Counts include trash; only physical removal releases capacity. Limits are deployment values,
-- checked by the service while this transaction still owns the counter row lock.
INSERT INTO database_counters SELECT workspace_id,'bases',workspace_id,count(*) FROM databases GROUP BY workspace_id;
INSERT INTO database_counters SELECT workspace_id,'rows',workspace_id,count(*) FROM database_rows GROUP BY workspace_id;
INSERT INTO database_counters SELECT workspace_id,'baseRows',database_id,count(*) FROM database_rows GROUP BY workspace_id,database_id;
INSERT INTO database_counters SELECT workspace_id,'properties',database_id,count(*) FROM database_properties GROUP BY workspace_id,database_id;
INSERT INTO database_counters SELECT workspace_id,'options',property_id,count(*) FROM property_options GROUP BY workspace_id,property_id;
CREATE FUNCTION database_count_delta(w uuid,s text,r uuid,delta integer) RETURNS void LANGUAGE sql AS $$
 INSERT INTO database_counters(workspace_id,scope,resource_id,used) VALUES(w,s,r,delta)
 ON CONFLICT(workspace_id,scope,resource_id) DO UPDATE SET used=database_counters.used+excluded.used;
$$;
CREATE FUNCTION database_count_objects() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE obj record; delta integer;
BEGIN
 IF TG_OP='INSERT' THEN obj:=NEW; delta:=1; ELSE obj:=OLD; delta:=-1; END IF;
 -- Workspace cascade deletes counters itself; do not recreate a deleted FK parent.
 IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=obj.workspace_id) THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='databases' THEN PERFORM database_count_delta(obj.workspace_id,'bases',obj.workspace_id,delta);
 ELSIF TG_TABLE_NAME='database_rows' THEN
  PERFORM database_count_delta(obj.workspace_id,'rows',obj.workspace_id,delta);
  PERFORM database_count_delta(obj.workspace_id,'baseRows',obj.database_id,delta);
 ELSIF TG_TABLE_NAME='database_properties' THEN PERFORM database_count_delta(obj.workspace_id,'properties',obj.database_id,delta);
 ELSIF TG_TABLE_NAME='property_options' THEN PERFORM database_count_delta(obj.workspace_id,'options',obj.property_id,delta);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER database_count_bases AFTER INSERT OR DELETE ON databases FOR EACH ROW EXECUTE FUNCTION database_count_objects();
CREATE TRIGGER database_count_rows AFTER INSERT OR DELETE ON database_rows FOR EACH ROW EXECUTE FUNCTION database_count_objects();
CREATE TRIGGER database_count_properties AFTER INSERT OR DELETE ON database_properties FOR EACH ROW EXECUTE FUNCTION database_count_objects();
CREATE TRIGGER database_count_options AFTER INSERT OR DELETE ON property_options FOR EACH ROW EXECUTE FUNCTION database_count_objects();
--> statement-breakpoint
CREATE FUNCTION database_refresh_row(w uuid,r uuid) RETURNS void LANGUAGE sql AS $$
 INSERT INTO database_row_search(workspace_id,database_id,row_page_id,relational_text)
 SELECT p.workspace_id,d.database_id,p.id,p.title||chr(10)||coalesce(string_agg(v.text_value,chr(10) ORDER BY prop.id),'')
 FROM pages p JOIN database_rows d ON d.workspace_id=p.workspace_id AND d.page_id=p.id
 LEFT JOIN database_properties prop ON prop.workspace_id=p.workspace_id AND prop.database_id=d.database_id AND prop.kind='text' AND prop.deleted_at IS NULL
 LEFT JOIN property_values v ON v.workspace_id=p.workspace_id AND v.row_page_id=p.id AND v.property_id=prop.id AND v.deleted_at IS NULL
 WHERE p.workspace_id=w AND p.id=r GROUP BY p.workspace_id,d.database_id,p.id
 ON CONFLICT(workspace_id,row_page_id) DO UPDATE SET relational_text=excluded.relational_text;
$$;
CREATE FUNCTION database_mark_row(w uuid,b uuid,r uuid,a uuid,property_change boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO database_row_changes(workspace_id,database_id,row_page_id,property_revision,first_dirty_at,last_dirty_at)
 VALUES(w,b,r,CASE WHEN property_change THEN 1 ELSE 0 END,clock_timestamp(),clock_timestamp())
 ON CONFLICT(workspace_id,row_page_id) DO UPDATE SET property_revision=database_row_changes.property_revision+CASE WHEN property_change THEN 1 ELSE 0 END,
 first_dirty_at=coalesce(database_row_changes.first_dirty_at,excluded.first_dirty_at),last_dirty_at=excluded.last_dirty_at;
 IF a IS NOT NULL THEN INSERT INTO database_row_authors VALUES(w,r,a) ON CONFLICT DO NOTHING; END IF;
END $$;
SELECT database_refresh_row(workspace_id,page_id) FROM database_rows;
