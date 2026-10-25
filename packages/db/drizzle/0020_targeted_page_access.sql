CREATE TABLE "page_access_pending" (
	"workspace_id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_access_state" (
	"workspace_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"level" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "page_access_state_workspace_id_member_id_page_id_pk" PRIMARY KEY("workspace_id","member_id","page_id"),
	CONSTRAINT "page_access_state_level_ck" CHECK ("page_access_state"."level" in ('none','read','edit')),
	CONSTRAINT "page_access_state_version_ck" CHECK ("page_access_state"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "page_access_pending" ADD CONSTRAINT "page_access_pending_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_access_state" ADD CONSTRAINT "page_access_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_access_state" ADD CONSTRAINT "page_access_state_workspace_id_member_id_workspace_members_workspace_id_id_fk" FOREIGN KEY ("workspace_id","member_id") REFERENCES "public"."workspace_members"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- One effective-access calculation for previews and durable per-page epochs.
CREATE FUNCTION content_effective_access(w uuid, candidate_tree jsonb DEFAULT NULL)
RETURNS TABLE(member_id uuid,page_id uuid,level text) LANGUAGE sql STABLE AS $$
 WITH RECURSIVE tree AS MATERIALIZED (
  SELECT p.id,p.parent_id,p.deleted_at IS NOT NULL AS archived FROM pages p
  WHERE p.workspace_id=w AND candidate_tree IS NULL
  UNION ALL
  SELECT c.id,c.parent_id,c.archived FROM jsonb_to_recordset(candidate_tree) c(id uuid,parent_id uuid,archived boolean)
  JOIN pages p ON p.id=c.id AND p.workspace_id=w WHERE candidate_tree IS NOT NULL
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
CREATE FUNCTION content_access_effects(w uuid,candidate_tree jsonb DEFAULT NULL,stored_before boolean DEFAULT false)
RETURNS TABLE(member_id uuid,page_id uuid,before_level text,after_level text) LANGUAGE sql STABLE AS $$
 WITH before_access AS MATERIALIZED (
  SELECT a.member_id,a.page_id,a.level FROM page_access_state a WHERE stored_before AND a.workspace_id=w AND a.level<>'none'
  UNION ALL SELECT * FROM content_effective_access(w) WHERE NOT stored_before
 ), after_access AS MATERIALIZED (SELECT * FROM content_effective_access(w,candidate_tree))
 SELECT coalesce(b.member_id,a.member_id),coalesce(b.page_id,a.page_id),coalesce(b.level,'none'),coalesce(a.level,'none')
 FROM before_access b FULL JOIN after_access a USING(member_id,page_id)
 WHERE b.level IS DISTINCT FROM a.level;
$$;
--> statement-breakpoint
-- Backfill preserves the old epoch of each currently accessible page. The browser
-- can retain a v3 copy only when that epoch still matches its old workspace ticket.
INSERT INTO page_access_state(workspace_id,member_id,page_id,level,version)
SELECT w.id,a.member_id,a.page_id,a.level,m.access_version FROM workspaces w
CROSS JOIN LATERAL content_effective_access(w.id) a JOIN workspace_members m ON m.id=a.member_id;
--> statement-breakpoint
DROP TRIGGER content_epoch_member ON workspace_members;
DROP TRIGGER content_epoch_subject ON access_subjects;
DROP TRIGGER content_epoch_grant ON access_grants;
DROP TRIGGER content_epoch_tree ON pages;
DROP FUNCTION content_bump_access_epoch();
DROP FUNCTION content_bump_tree_epoch();
--> statement-breakpoint
CREATE FUNCTION content_queue_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; queued uuid;
BEGIN
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
CREATE FUNCTION content_reconcile_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM page_access_pending WHERE workspace_id=NEW.workspace_id) THEN RETURN NULL; END IF;
 SELECT access_version INTO v FROM workspaces WHERE id=NEW.workspace_id;
 WITH changed AS MATERIALIZED (
  SELECT e.* FROM content_access_effects(NEW.workspace_id,NULL,true) e
  JOIN workspace_members m ON m.id=e.member_id AND m.workspace_id=NEW.workspace_id
 ), applied AS (
  INSERT INTO page_access_state(workspace_id,member_id,page_id,level,version)
  SELECT NEW.workspace_id,member_id,page_id,after_level,v FROM changed
  ON CONFLICT (workspace_id,member_id,page_id) DO UPDATE SET level=excluded.level,version=excluded.version
  RETURNING member_id
 ) UPDATE workspace_members SET access_version=v WHERE id IN (SELECT member_id FROM applied);
 DELETE FROM page_access_pending WHERE workspace_id=NEW.workspace_id;
 PERFORM pg_notify('memoria_collaboration',json_build_object('schema',current_schema())::text);
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER content_epoch_member AFTER INSERT OR DELETE OR UPDATE OF role ON workspace_members FOR EACH ROW EXECUTE FUNCTION content_queue_access();
CREATE TRIGGER content_epoch_subject AFTER INSERT OR UPDATE OR DELETE ON access_subjects FOR EACH ROW EXECUTE FUNCTION content_queue_access();
CREATE TRIGGER content_epoch_grant AFTER INSERT OR UPDATE OR DELETE ON access_grants FOR EACH ROW EXECUTE FUNCTION content_queue_access();
CREATE TRIGGER content_epoch_tree AFTER INSERT OR DELETE OR UPDATE OF parent_id,deleted_at ON pages FOR EACH ROW EXECUTE FUNCTION content_queue_access();
CREATE TRIGGER content_epoch_workspace AFTER UPDATE OF deleted_at ON workspaces FOR EACH ROW EXECUTE FUNCTION content_queue_access();
CREATE CONSTRAINT TRIGGER content_access_commit AFTER INSERT ON page_access_pending DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION content_reconcile_access();

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
 JOIN pages p ON p.id=c.page AND p.workspace_id=c.workspace
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
