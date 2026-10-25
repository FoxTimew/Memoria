CREATE FUNCTION auth_session_can_access_workspace(target uuid, workspace uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT auth_session_can_access_content(target) AND EXISTS(
 SELECT 1 FROM auth_sessions s JOIN workspace_members m ON m.user_id=s.user_id AND m.workspace_id=workspace
 JOIN workspaces w ON w.id=m.workspace_id AND w.deleted_at IS NULL
 LEFT JOIN workspace_policies p ON p.workspace_id=w.id
 WHERE s.id=target AND m.role IN ('owner','member')
 AND (NOT coalesce(p.require_strong_auth,false) OR auth_session_is_strong(target)
 OR m.mfa_deadline>statement_timestamp()))
$$;
--> statement-breakpoint
-- New members never inherit the existing members' grace period, regardless of insertion path.
CREATE FUNCTION workspace_member_security_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text,0));
 IF EXISTS(SELECT 1 FROM workspace_policies WHERE workspace_id=NEW.workspace_id AND require_strong_auth) THEN
  NEW.mfa_deadline=clock_timestamp();
 ELSE NEW.mfa_deadline=NULL;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER workspace_member_security_deadline BEFORE INSERT OR UPDATE OF user_id,workspace_id ON workspace_members FOR EACH ROW EXECUTE FUNCTION workspace_member_security_deadline();
--> statement-breakpoint
CREATE FUNCTION collab_lock_security() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
 IF TG_TABLE_NAME='workspace_policies' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.workspace_id::text,0));
  PERFORM id FROM pages WHERE workspace_id=OLD.workspace_id ORDER BY id FOR NO KEY UPDATE;
 ELSIF TG_TABLE_NAME='session_assurance' THEN
  SELECT user_id INTO target FROM auth_sessions WHERE id=OLD.session_id;
  IF target IS NOT NULL THEN PERFORM collab_lock_user_pages(target); END IF;
 ELSE
  PERFORM collab_lock_user_pages(OLD.user_id);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION collab_notify_security() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('memoria_collaboration',json_build_object('schema',current_schema(),'table',TG_TABLE_NAME)::text);
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER collab_lock_policy BEFORE DELETE OR UPDATE OF require_strong_auth,grace_days ON workspace_policies FOR EACH ROW EXECUTE FUNCTION collab_lock_security();
CREATE TRIGGER collab_notify_policy AFTER DELETE OR INSERT OR UPDATE OF require_strong_auth,grace_days ON workspace_policies FOR EACH ROW EXECUTE FUNCTION collab_notify_security();
CREATE TRIGGER collab_lock_member_deadline BEFORE UPDATE OF mfa_deadline ON workspace_members FOR EACH ROW EXECUTE FUNCTION collab_lock_revocation();
CREATE TRIGGER collab_notify_member_deadline AFTER UPDATE OF mfa_deadline ON workspace_members FOR EACH ROW EXECUTE FUNCTION collab_notify_security();
CREATE TRIGGER collab_lock_security_generation BEFORE UPDATE OF version ON account_security FOR EACH ROW EXECUTE FUNCTION collab_lock_security();
CREATE TRIGGER collab_notify_security_generation AFTER UPDATE OF version ON account_security FOR EACH ROW EXECUTE FUNCTION collab_notify_security();
CREATE TRIGGER collab_lock_assurance BEFORE DELETE OR UPDATE ON session_assurance FOR EACH ROW EXECUTE FUNCTION collab_lock_security();
CREATE TRIGGER collab_notify_assurance AFTER DELETE OR INSERT OR UPDATE ON session_assurance FOR EACH ROW EXECUTE FUNCTION collab_notify_security();
CREATE TRIGGER collab_lock_totp BEFORE DELETE OR UPDATE OF verified,user_id ON auth_two_factors FOR EACH ROW EXECUTE FUNCTION collab_lock_security();
CREATE TRIGGER collab_notify_totp AFTER DELETE OR UPDATE OF verified,user_id ON auth_two_factors FOR EACH ROW EXECUTE FUNCTION collab_notify_security();
CREATE TRIGGER collab_lock_passkey BEFORE DELETE OR UPDATE OF user_id ON auth_passkeys FOR EACH ROW EXECUTE FUNCTION collab_lock_security();
CREATE TRIGGER collab_notify_passkey AFTER DELETE OR UPDATE OF user_id ON auth_passkeys FOR EACH ROW EXECUTE FUNCTION collab_notify_security();
CREATE TRIGGER collab_lock_factor_enabled BEFORE UPDATE OF two_factor_enabled ON auth_users FOR EACH ROW EXECUTE FUNCTION collab_lock_revocation();
CREATE TRIGGER collab_notify_factor_enabled AFTER UPDATE OF two_factor_enabled ON auth_users FOR EACH ROW EXECUTE FUNCTION collab_notify_security();
