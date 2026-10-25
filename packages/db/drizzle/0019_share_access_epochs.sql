ALTER TABLE "workspace_members" ADD COLUMN "access_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "access_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- Durable epochs survive remove/rejoin and revoke/regrant. A subject's cache must
-- never adopt an epoch acquired by an older HTTP request or an already loaded Y.Doc.
CREATE FUNCTION content_bump_access_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; v integer; targets uuid[];
BEGIN
 w=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 IF TG_TABLE_NAME='workspace_members' THEN
  IF TG_OP='UPDATE' AND OLD.role=NEW.role THEN RETURN NEW; END IF;
  targets=ARRAY[CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END];
 ELSIF TG_TABLE_NAME='access_subjects' THEN
  targets=ARRAY[CASE WHEN TG_OP='DELETE' THEN OLD.member_id ELSE NEW.member_id END];
  IF TG_OP='UPDATE' THEN targets=array_append(targets,OLD.member_id); END IF;
 ELSE
  SELECT array_agg(member_id) INTO targets FROM access_subjects WHERE workspace_id=w
   AND (id=CASE WHEN TG_OP='DELETE' THEN OLD.subject_id ELSE NEW.subject_id END
    OR (TG_OP='UPDATE' AND id=OLD.subject_id));
 END IF;
 UPDATE workspaces SET access_version=access_version+1 WHERE id=w RETURNING access_version INTO v;
 UPDATE workspace_members SET access_version=v WHERE workspace_id=w AND id=ANY(targets);
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER content_epoch_member AFTER INSERT OR DELETE OR UPDATE OF role ON workspace_members FOR EACH ROW EXECUTE FUNCTION content_bump_access_epoch();
CREATE TRIGGER content_epoch_subject AFTER INSERT OR UPDATE OR DELETE ON access_subjects FOR EACH ROW EXECUTE FUNCTION content_bump_access_epoch();
CREATE TRIGGER content_epoch_grant AFTER INSERT OR UPDATE OR DELETE ON access_grants FOR EACH ROW EXECUTE FUNCTION content_bump_access_epoch();
--> statement-breakpoint
CREATE FUNCTION content_bump_tree_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid; v integer;
BEGIN
 IF TG_OP='UPDATE' AND OLD.parent_id IS NOT DISTINCT FROM NEW.parent_id AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN RETURN NULL; END IF;
 w=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 UPDATE workspaces SET access_version=access_version+1 WHERE id=w RETURNING access_version INTO v;
 -- New pages invalidate previews, but cannot reduce an existing permission.
 IF TG_OP<>'INSERT' THEN
  UPDATE workspace_members SET access_version=v WHERE workspace_id=w AND
   (role='guest' OR TG_OP='DELETE' OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at);
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER content_epoch_tree AFTER INSERT OR DELETE OR UPDATE OF parent_id,deleted_at ON pages FOR EACH ROW EXECUTE FUNCTION content_bump_tree_epoch();

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
 AND (c.accessversion IS NULL OR c.accessversion=x.access_version);
END $$;
