-- A workspace permit alone never grants a guest a page.
CREATE OR REPLACE FUNCTION auth_session_can_access_workspace(target uuid, workspace uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
 RETURN auth_session_can_access_content(target) AND EXISTS(
 SELECT 1 FROM auth_sessions s JOIN workspace_members m ON m.user_id=s.user_id AND m.workspace_id=workspace
 JOIN workspaces w ON w.id=m.workspace_id AND w.deleted_at IS NULL
 LEFT JOIN workspace_policies p ON p.workspace_id=w.id
 WHERE s.id=target AND m.role IN ('owner','admin','member','guest')
 AND (NOT coalesce(p.require_strong_auth,false) OR auth_session_is_strong(target)
 OR m.mfa_deadline>statement_timestamp()));
END $$;
--> statement-breakpoint
CREATE FUNCTION content_resolve_access(requests jsonb)
RETURNS TABLE(key text, actor uuid, level text, role text) LANGUAGE plpgsql STABLE AS $$
BEGIN
 RETURN QUERY WITH RECURSIVE candidates AS MATERIALIZED (
 SELECT * FROM jsonb_to_recordset(requests) AS c(key text,userid uuid,session uuid,workspace uuid,page uuid)
 ), contexts AS MATERIALIZED (
 SELECT c.*,m.id AS member_id,m.role,a.id AS actor FROM
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
 AND (x.role IN ('owner','admin','member') OR grants.rank IS NOT NULL);
END $$;
--> statement-breakpoint
-- Conservative workspace coverage protects cascades and overlapping shares. No workspace
-- mutex is acquired by Yjs writes; rights mutations wait for in-flight page commits.
CREATE FUNCTION content_lock_rights() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w uuid;
BEGIN
 w=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 IF TG_OP='UPDATE' AND (OLD.workspace_id<>NEW.workspace_id OR OLD.id<>NEW.id) THEN
  RAISE EXCEPTION 'Immutable access identity' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(w::text,0));
 PERFORM id FROM pages WHERE workspace_id=w ORDER BY id FOR NO KEY UPDATE;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE TRIGGER content_lock_grant BEFORE INSERT OR UPDATE OR DELETE ON access_grants FOR EACH ROW EXECUTE FUNCTION content_lock_rights();
CREATE TRIGGER content_notify_grant AFTER INSERT OR UPDATE OR DELETE ON access_grants FOR EACH ROW EXECUTE FUNCTION collab_notify_security();
CREATE TRIGGER content_lock_subject BEFORE INSERT OR UPDATE OR DELETE ON access_subjects FOR EACH ROW EXECUTE FUNCTION content_lock_rights();
CREATE TRIGGER content_notify_subject AFTER INSERT OR UPDATE OR DELETE ON access_subjects FOR EACH ROW EXECUTE FUNCTION collab_notify_security();
CREATE TRIGGER a_content_lock_member BEFORE DELETE OR UPDATE OF role,user_id,workspace_id,mfa_deadline ON workspace_members FOR EACH ROW EXECUTE FUNCTION content_lock_rights();
--> statement-breakpoint
CREATE FUNCTION content_clear_promoted_grants() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE removed integer;
BEGIN
 IF OLD.role='guest' AND NEW.role<>'guest' THEN
  DELETE FROM access_grants g USING access_subjects s WHERE g.subject_id=s.id
   AND s.workspace_id=NEW.workspace_id AND s.member_id=NEW.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed>0 THEN
   INSERT INTO audit_logs(workspace_id,action,resource_type,resource_id,metadata)
   VALUES(NEW.workspace_id,'member.guest_grants.cleared','member',NEW.id,jsonb_build_object('count',removed));
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER content_clear_promoted_grants AFTER UPDATE OF role ON workspace_members FOR EACH ROW EXECUTE FUNCTION content_clear_promoted_grants();
