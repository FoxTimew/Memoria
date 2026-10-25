CREATE OR REPLACE FUNCTION auth_session_can_access_content(target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
 WHERE s.id=target AND s.expires_at>statement_timestamp() AND u.email_verified
 AND NOT EXISTS(SELECT 1 FROM account_security sec WHERE sec.user_id=s.user_id AND sec.recovery_required)
 AND NOT EXISTS(SELECT 1 FROM session_assurance a WHERE a.session_id=s.id AND a.method='recovery')
 AND (auth_session_is_strong(s.id) OR (
 NOT u.two_factor_enabled AND NOT EXISTS(SELECT 1 FROM auth_two_factors f WHERE f.user_id=s.user_id AND f.verified)
 AND NOT EXISTS(SELECT 1 FROM auth_passkeys p WHERE p.user_id=s.user_id))))
$$;
--> statement-breakpoint
CREATE TRIGGER collab_lock_recovery BEFORE UPDATE OF recovery_required ON account_security FOR EACH ROW EXECUTE FUNCTION collab_lock_security();
CREATE TRIGGER collab_notify_recovery AFTER UPDATE OF recovery_required ON account_security FOR EACH ROW EXECUTE FUNCTION collab_notify_security();
-- Better Auth's sliding expiry must never extend a restricted recovery session.
CREATE FUNCTION auth_bound_recovery_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM session_assurance WHERE session_id=OLD.id AND method='recovery') THEN
    NEW.expires_at := LEAST(NEW.expires_at, OLD.expires_at, OLD.created_at + interval '15 minutes');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER auth_bound_recovery_expiry BEFORE UPDATE OF expires_at ON auth_sessions
FOR EACH ROW EXECUTE FUNCTION auth_bound_recovery_session();
--> statement-breakpoint
