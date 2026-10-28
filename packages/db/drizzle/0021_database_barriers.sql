CREATE TABLE "database_cell_versions" (
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"row_page_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "database_cell_versions_workspace_id_row_page_id_property_id_pk" PRIMARY KEY("workspace_id","row_page_id","property_id"),
	CONSTRAINT "cell_version_ck" CHECK ("database_cell_versions"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "database_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" uuid,
	CONSTRAINT "database_people_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "database_people_member_uq" UNIQUE("member_id")
);
--> statement-breakpoint
ALTER TABLE "person_values" DROP CONSTRAINT "person_values_workspace_id_member_id_workspace_members_workspace_id_id_fk";
--> statement-breakpoint
DROP INDEX "pages_sibling_position_uq";--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "kind" text DEFAULT 'page' NOT NULL;--> statement-breakpoint
ALTER TABLE "database_rows" ADD COLUMN "lifecycle_version" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "schema_version" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "database_cell_versions" ADD CONSTRAINT "database_cell_versions_workspace_id_database_id_row_page_id_database_rows_workspace_id_database_id_page_id_fk" FOREIGN KEY ("workspace_id","database_id","row_page_id") REFERENCES "public"."database_rows"("workspace_id","database_id","page_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_cell_versions" ADD CONSTRAINT "database_cell_versions_workspace_id_property_id_database_properties_workspace_id_id_fk" FOREIGN KEY ("workspace_id","property_id") REFERENCES "public"."database_properties"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_people" ADD CONSTRAINT "database_people_workspace_id_member_id_workspace_members_workspace_id_id_fk" FOREIGN KEY ("workspace_id","member_id") REFERENCES "public"."workspace_members"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO database_people(id,workspace_id,member_id) SELECT id,workspace_id,id FROM workspace_members;
--> statement-breakpoint
ALTER TABLE "person_values" ADD CONSTRAINT "person_values_workspace_id_member_id_database_people_workspace_id_id_fk" FOREIGN KEY ("workspace_id","member_id") REFERENCES "public"."database_people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pages_sibling_position_uq" ON "pages" USING btree ("workspace_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),"position") WHERE "pages"."deleted_at" is null and "pages"."kind" = 'page';--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_kind_ck" CHECK ("pages"."kind" in ('page','database_row') and ("pages"."kind" = 'page' or "pages"."parent_id" is null));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION content_effective_access(w uuid, candidate_tree jsonb DEFAULT NULL)
RETURNS TABLE(member_id uuid,page_id uuid,level text) LANGUAGE sql STABLE AS $$
 WITH RECURSIVE tree AS MATERIALIZED (
  SELECT p.id,p.parent_id,p.deleted_at IS NOT NULL AS archived FROM pages p
  WHERE p.workspace_id=w AND p.kind='page' AND candidate_tree IS NULL
  UNION ALL
  SELECT c.id,c.parent_id,c.archived FROM jsonb_to_recordset(candidate_tree) c(id uuid,parent_id uuid,archived boolean)
  JOIN pages p ON p.id=c.id AND p.workspace_id=w AND p.kind='page' WHERE candidate_tree IS NOT NULL
 ), visible AS (
  SELECT t.id,ARRAY[t.id] AS path FROM tree t WHERE t.parent_id IS NULL AND NOT t.archived
  UNION ALL SELECT t.id,v.path||t.id FROM tree t JOIN visible v ON t.parent_id=v.id
  WHERE NOT t.archived AND cardinality(v.path)<50
 ), memberships AS MATERIALIZED (
  SELECT m.id,m.role FROM workspace_members m JOIN workspaces x ON x.id=m.workspace_id
  WHERE m.workspace_id=w AND x.deleted_at IS NULL
 ), guest_access AS (
  SELECT m.id AS member_id,v.id AS page_id,max(CASE g.level WHEN 'edit' THEN 2 ELSE 1 END) AS rank
  FROM visible v CROSS JOIN LATERAL unnest(v.path) ancestor(id)
  JOIN access_grants g ON g.workspace_id=w AND g.resource_id=ancestor.id
   AND g.resource_type='page' AND g.deleted_at IS NULL AND (g.inherit OR g.resource_id=v.id)
  JOIN access_subjects s ON s.id=g.subject_id AND s.workspace_id=w AND s.kind='member' AND s.deleted_at IS NULL
  JOIN memberships m ON m.id=s.member_id AND m.role='guest'
  GROUP BY m.id,v.id
 ) SELECT m.id,v.id,'edit'::text FROM memberships m CROSS JOIN visible v WHERE m.role IN ('owner','admin','member')
 UNION ALL SELECT g.member_id,g.page_id,CASE g.rank WHEN 2 THEN 'edit' ELSE 'read' END FROM guest_access g;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION content_queue_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; queued uuid;
BEGIN
 IF TG_TABLE_NAME='pages' THEN
  IF (CASE WHEN TG_OP='DELETE' THEN OLD.kind ELSE NEW.kind END)='database_row' THEN RETURN NULL; END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='pages' THEN
   IF OLD.parent_id IS NOT DISTINCT FROM NEW.parent_id AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME='workspace_members' THEN
   IF OLD.role=NEW.role THEN RETURN NULL; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME='workspaces' THEN w=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
 ELSE w=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END; END IF;
 IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=w) THEN RETURN NULL; END IF;
 INSERT INTO page_access_pending VALUES(w) ON CONFLICT DO NOTHING RETURNING workspace_id INTO queued;
 IF queued IS NOT NULL THEN UPDATE workspaces SET access_version=access_version+1 WHERE id=w; END IF;
 RETURN NULL;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION content_resolve_access(requests jsonb)
RETURNS TABLE(key text, actor uuid, level text, role text) LANGUAGE plpgsql STABLE AS $$
BEGIN
 RETURN QUERY WITH RECURSIVE candidates AS MATERIALIZED (
 SELECT * FROM jsonb_to_recordset(requests) AS c(key text,userid uuid,session uuid,workspace uuid,page uuid,accessversion integer)
 ), contexts AS MATERIALIZED (
 SELECT c.*,m.id AS member_id,m.role,m.access_version,a.id AS actor FROM
 (SELECT DISTINCT userid,session,workspace FROM candidates) c
 JOIN auth_sessions s ON s.id=c.session AND s.user_id=c.userid
 JOIN workspace_members m ON m.workspace_id=c.workspace AND m.user_id=c.userid
 JOIN LATERAL(SELECT id FROM actors WHERE workspace_id=c.workspace AND user_id=c.userid AND kind='user' ORDER BY created_at,id LIMIT 1) a ON true
 WHERE auth_session_can_access_workspace(c.session,c.workspace)
 ), ancestors AS (
 SELECT c.key,p.id,p.parent_id,p.deleted_at,p.workspace_id,1 AS depth FROM candidates c
 JOIN contexts x ON x.userid=c.userid AND x.session=c.session AND x.workspace=c.workspace
 JOIN pages p ON p.id=c.page AND p.workspace_id=c.workspace AND p.kind='page'
 UNION ALL SELECT a.key,p.id,p.parent_id,p.deleted_at,p.workspace_id,a.depth+1
 FROM ancestors a JOIN pages p ON p.id=a.parent_id AND p.workspace_id=a.workspace_id WHERE a.depth<51
 ) SELECT c.key,x.actor,CASE WHEN x.role<>'guest' THEN 'edit'
 WHEN grants.rank=2 THEN 'edit' ELSE 'read' END,x.role
 FROM candidates c JOIN contexts x ON x.userid=c.userid AND x.session=c.session AND x.workspace=c.workspace
 LEFT JOIN LATERAL (
 SELECT max(CASE WHEN g.level='edit' THEN 2 ELSE 1 END) AS rank
 FROM access_subjects s JOIN access_grants g ON g.subject_id=s.id AND g.workspace_id=s.workspace_id
 JOIN ancestors a ON a.key=c.key AND a.id=g.resource_id AND a.workspace_id=g.workspace_id
 WHERE x.role='guest' AND s.workspace_id=c.workspace AND s.kind='member' AND s.member_id=x.member_id
 AND s.deleted_at IS NULL AND g.deleted_at IS NULL AND g.resource_type='page' AND (a.depth=1 OR g.inherit)
 ) grants ON true
 WHERE EXISTS(SELECT 1 FROM ancestors a WHERE a.key=c.key AND a.parent_id IS NULL)
 AND NOT EXISTS(SELECT 1 FROM ancestors a WHERE a.key=c.key AND (a.deleted_at IS NOT NULL OR a.depth>50))
 AND (x.role IN ('owner','admin','member') OR grants.rank IS NOT NULL)
 AND (c.accessversion IS NULL OR EXISTS(SELECT 1 FROM page_access_state e WHERE e.workspace_id=c.workspace AND e.member_id=x.member_id AND e.page_id=c.page AND e.version=c.accessversion AND e.level<>'none'));
END $$;
--> statement-breakpoint
-- The container row is the base latch; database_rows is the lifecycle latch.
CREATE FUNCTION database_lock_workspace(w uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text,0));
 PERFORM id FROM databases WHERE workspace_id=w ORDER BY id FOR UPDATE;
 PERFORM id FROM pages WHERE workspace_id=w AND kind='page' ORDER BY id FOR NO KEY UPDATE;
END $$;
--> statement-breakpoint
CREATE FUNCTION database_lock_rows(w uuid, targets uuid[], exclusive_lifecycle boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM d.id FROM databases d WHERE d.workspace_id=w AND EXISTS(
 SELECT 1 FROM database_rows r WHERE r.workspace_id=w AND r.database_id=d.id AND r.page_id=ANY(targets)) ORDER BY d.id FOR SHARE;
 IF exclusive_lifecycle THEN
  PERFORM r.id FROM database_rows r WHERE r.workspace_id=w AND r.page_id=ANY(targets) ORDER BY r.page_id FOR UPDATE;
 ELSE
  PERFORM r.id FROM database_rows r WHERE r.workspace_id=w AND r.page_id=ANY(targets) ORDER BY r.page_id FOR SHARE;
 END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION content_lock_document(w uuid,target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM database_lock_rows(w,ARRAY[target]);
 PERFORM id FROM pages WHERE workspace_id=w AND id=target FOR NO KEY UPDATE;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION content_lock_rights() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid;
BEGIN
 w=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 IF TG_OP='UPDATE' AND (OLD.workspace_id<>NEW.workspace_id OR OLD.id<>NEW.id) THEN
  RAISE EXCEPTION 'Immutable access identity' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='access_grants' AND TG_OP<>'DELETE' THEN
  IF NEW.resource_type='page' AND EXISTS(SELECT 1 FROM pages WHERE workspace_id=w AND id=NEW.resource_id AND kind='database_row') THEN
   RAISE EXCEPTION 'Rows inherit container access' USING ERRCODE='23514';
  END IF;
 END IF;
 PERFORM database_lock_workspace(w);
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION collab_lock_user_pages(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE w uuid;
BEGIN
 -- Acquire all mutation mutexes and all bases before any ordinary page.
 FOR w IN SELECT workspace_id FROM workspace_members WHERE user_id=target ORDER BY workspace_id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(w::text,0));
 END LOOP;
 PERFORM d.id FROM databases d WHERE EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=d.workspace_id AND m.user_id=target) ORDER BY d.id FOR UPDATE OF d;
 PERFORM p.id FROM pages p WHERE p.kind='page' AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=p.workspace_id AND m.user_id=target) ORDER BY p.id FOR NO KEY UPDATE OF p;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION collab_lock_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='auth_sessions' THEN PERFORM collab_lock_user_pages(OLD.user_id);
 ELSIF TG_TABLE_NAME='auth_users' THEN PERFORM collab_lock_user_pages(OLD.id);
 ELSIF TG_TABLE_NAME='workspace_members' THEN PERFORM database_lock_workspace(OLD.workspace_id);
 ELSIF TG_TABLE_NAME='workspaces' THEN PERFORM database_lock_workspace(OLD.id);
 ELSIF TG_TABLE_NAME='pages' THEN
  IF OLD.kind='database_row' THEN
   PERFORM database_lock_rows(OLD.workspace_id,ARRAY[OLD.id],true);
   UPDATE database_rows SET lifecycle_version=lifecycle_version+1 WHERE workspace_id=OLD.workspace_id AND page_id=OLD.id;
  ELSE PERFORM database_lock_workspace(OLD.workspace_id);
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION collab_lock_security() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='workspace_policies' THEN PERFORM database_lock_workspace(OLD.workspace_id);
 ELSIF TG_TABLE_NAME='session_assurance' THEN
  SELECT user_id INTO target FROM auth_sessions WHERE id=OLD.session_id;
  IF target IS NOT NULL THEN PERFORM collab_lock_user_pages(target); END IF;
 ELSE PERFORM collab_lock_user_pages(OLD.user_id);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION database_detach_person() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE database_people SET member_id=NULL WHERE workspace_id=OLD.workspace_id AND member_id=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER database_detach_member BEFORE DELETE ON workspace_members FOR EACH ROW EXECUTE FUNCTION database_detach_person();
--> statement-breakpoint
CREATE FUNCTION database_page_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.kind<>OLD.kind OR NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id) THEN
  RAISE EXCEPTION 'Immutable page identity' USING ERRCODE='23514';
 END IF;
 IF NEW.parent_id IS NOT NULL AND EXISTS(SELECT 1 FROM pages WHERE id=NEW.parent_id AND kind='database_row') THEN
  RAISE EXCEPTION 'Rows cannot have children' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER database_page_identity BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION database_page_identity();
--> statement-breakpoint
CREATE FUNCTION database_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.workspace_id<>OLD.workspace_id OR NEW.page_id<>OLD.page_id OR NEW.id<>OLD.id) THEN
  RAISE EXCEPTION 'Immutable database identity' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='databases' THEN
  PERFORM database_lock_workspace(NEW.workspace_id);
  IF NOT EXISTS(SELECT 1 FROM pages WHERE workspace_id=NEW.workspace_id AND id=NEW.page_id AND kind='page') THEN
   RAISE EXCEPTION 'Container must be an ordinary page' USING ERRCODE='23514';
  END IF;
 ELSE
  IF TG_OP='UPDATE' AND NEW.database_id<>OLD.database_id THEN RAISE EXCEPTION 'Immutable row database' USING ERRCODE='23514'; END IF;
  PERFORM id FROM databases WHERE workspace_id=NEW.workspace_id AND id=NEW.database_id FOR SHARE;
  IF NOT EXISTS(SELECT 1 FROM pages WHERE workspace_id=NEW.workspace_id AND id=NEW.page_id AND kind='database_row') THEN
   RAISE EXCEPTION 'Row must be a row page' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER database_identity BEFORE INSERT OR UPDATE OF id,workspace_id,page_id ON databases FOR EACH ROW EXECUTE FUNCTION database_identity();
CREATE TRIGGER database_row_identity BEFORE INSERT OR UPDATE OF id,workspace_id,page_id,database_id ON database_rows FOR EACH ROW EXECUTE FUNCTION database_identity();
--> statement-breakpoint
-- Explicit row scope: legacy ordinary-page tickets cannot address a row.
CREATE FUNCTION database_resolve_access(requests jsonb)
RETURNS TABLE(key text,actor uuid,level text,role text) LANGUAGE plpgsql STABLE AS $$
BEGIN
 RETURN QUERY WITH candidates AS MATERIALIZED (
 SELECT c.*,d.page_id AS container FROM jsonb_to_recordset(requests)
 c(key text,userid uuid,session uuid,workspace uuid,page uuid,database uuid,baseversion integer,lifecycle bigint)
 JOIN database_rows r ON r.workspace_id=c.workspace AND r.database_id=c.database AND r.page_id=c.page AND r.deleted_at IS NULL
 JOIN databases d ON d.workspace_id=r.workspace_id AND d.id=r.database_id AND d.deleted_at IS NULL
 JOIN pages p ON p.workspace_id=c.workspace AND p.id=c.page AND p.kind='database_row' AND p.deleted_at IS NULL
 WHERE (c.lifecycle IS NULL OR c.lifecycle=r.lifecycle_version)
 ), mapped AS (
 SELECT jsonb_agg(jsonb_build_object('key',c.key,'userid',c.userid,'session',c.session,'workspace',c.workspace,'page',c.container,'accessversion',c.baseversion)) AS input FROM candidates c
 ) SELECT a.* FROM mapped m CROSS JOIN LATERAL content_resolve_access(coalesce(m.input,'[]'::jsonb)) a;
END $$;

--> statement-breakpoint
CREATE FUNCTION database_attach_person() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO database_people(id,workspace_id,member_id) VALUES(NEW.id,NEW.workspace_id,NEW.id);
 RETURN NULL;
END $$;
CREATE TRIGGER database_attach_member AFTER INSERT ON workspace_members FOR EACH ROW EXECUTE FUNCTION database_attach_person();

