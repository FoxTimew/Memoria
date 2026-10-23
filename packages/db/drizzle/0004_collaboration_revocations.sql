-- Revocations serialize with the journal's page row lock. No workspace lock in journal writes.
CREATE FUNCTION collab_lock_user_pages(target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM p.id FROM pages p WHERE EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=p.workspace_id AND m.user_id=target) ORDER BY p.id FOR NO KEY UPDATE OF p;
END $$;
--> statement-breakpoint
CREATE FUNCTION collab_lock_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='auth_sessions' THEN
  PERFORM collab_lock_user_pages(OLD.user_id);
 ELSIF TG_TABLE_NAME='auth_users' THEN
  PERFORM collab_lock_user_pages(OLD.id);
 ELSIF TG_TABLE_NAME='workspace_members' THEN
  PERFORM p.id FROM pages p WHERE p.workspace_id=OLD.workspace_id ORDER BY p.id FOR NO KEY UPDATE OF p;
 ELSIF TG_TABLE_NAME='workspaces' THEN
  PERFORM p.id FROM pages p WHERE p.workspace_id=OLD.id ORDER BY p.id FOR NO KEY UPDATE OF p;
 ELSIF TG_TABLE_NAME='pages' THEN
  PERFORM p.id FROM pages p WHERE p.id IN (
   WITH RECURSIVE descendants AS (SELECT OLD.id AS id UNION SELECT child.id FROM pages child JOIN descendants d ON child.parent_id=d.id WHERE child.workspace_id=OLD.workspace_id) SELECT id FROM descendants
  ) ORDER BY p.id FOR NO KEY UPDATE OF p;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION collab_notify_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('memoria_collaboration',json_build_object('schema',current_schema(),'table',TG_TABLE_NAME,'id',OLD.id)::text);
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER collab_lock_session BEFORE DELETE OR UPDATE OF expires_at,user_id ON auth_sessions FOR EACH ROW EXECUTE FUNCTION collab_lock_revocation();
CREATE TRIGGER collab_notify_session AFTER DELETE OR UPDATE OF expires_at,user_id ON auth_sessions FOR EACH ROW EXECUTE FUNCTION collab_notify_revocation();
CREATE TRIGGER collab_lock_member BEFORE DELETE OR UPDATE OF role,workspace_id,user_id ON workspace_members FOR EACH ROW EXECUTE FUNCTION collab_lock_revocation();
CREATE TRIGGER collab_notify_member AFTER DELETE OR UPDATE OF role,workspace_id,user_id ON workspace_members FOR EACH ROW EXECUTE FUNCTION collab_notify_revocation();
CREATE TRIGGER collab_lock_user BEFORE DELETE OR UPDATE OF email_verified ON auth_users FOR EACH ROW EXECUTE FUNCTION collab_lock_revocation();
CREATE TRIGGER collab_notify_user AFTER DELETE OR UPDATE OF email_verified ON auth_users FOR EACH ROW EXECUTE FUNCTION collab_notify_revocation();
CREATE TRIGGER collab_lock_workspace BEFORE DELETE OR UPDATE OF deleted_at ON workspaces FOR EACH ROW EXECUTE FUNCTION collab_lock_revocation();
CREATE TRIGGER collab_notify_workspace AFTER DELETE OR UPDATE OF deleted_at ON workspaces FOR EACH ROW EXECUTE FUNCTION collab_notify_revocation();
CREATE TRIGGER collab_lock_page BEFORE DELETE OR UPDATE OF deleted_at,parent_id ON pages FOR EACH ROW EXECUTE FUNCTION collab_lock_revocation();
CREATE TRIGGER collab_notify_page AFTER DELETE OR UPDATE OF deleted_at,parent_id ON pages FOR EACH ROW EXECUTE FUNCTION collab_notify_revocation();
--> statement-breakpoint
-- Projection and its integrity guard serialize per page rather than per workspace.
CREATE OR REPLACE FUNCTION check_block_tree() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('blocks:' || NEW.page_id::text,0));
 IF EXISTS(WITH RECURSIVE ancestors AS (
 SELECT id,parent_id FROM blocks WHERE workspace_id=NEW.workspace_id AND page_id=NEW.page_id AND id=NEW.parent_id
 UNION SELECT b.id,b.parent_id FROM blocks b JOIN ancestors a ON b.id=a.parent_id WHERE b.workspace_id=NEW.workspace_id AND b.page_id=NEW.page_id
 ) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE EXCEPTION 'Block tree cycle' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
