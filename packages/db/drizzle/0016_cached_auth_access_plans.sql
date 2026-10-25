-- Reuse PL/pgSQL statement plans, never authorization results. The expressions,
-- STABLE statement snapshot and all existing revocation locks remain unchanged.
CREATE OR REPLACE FUNCTION auth_session_is_strong(target uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
 RETURN (
 SELECT EXISTS(SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
 JOIN session_assurance a ON a.session_id=s.id LEFT JOIN account_security sec ON sec.user_id=s.user_id
 WHERE s.id=target AND s.expires_at>statement_timestamp() AND u.email_verified
 AND a.security_version=coalesce(sec.version,0) AND a.verified_at<=statement_timestamp()
 AND ((a.method='totp' AND EXISTS(SELECT 1 FROM auth_two_factors f WHERE f.id=a.factor_id AND f.user_id=s.user_id AND f.verified AND u.two_factor_enabled))
 OR (a.method='passkey' AND EXISTS(SELECT 1 FROM auth_passkeys p WHERE p.id=a.factor_id AND p.user_id=s.user_id))))
 );
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_session_can_access_content(target uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
 RETURN (
 SELECT EXISTS(SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
 WHERE s.id=target AND s.expires_at>statement_timestamp() AND u.email_verified
 AND NOT EXISTS(SELECT 1 FROM account_security sec WHERE sec.user_id=s.user_id AND sec.recovery_required)
 AND NOT EXISTS(SELECT 1 FROM session_assurance a WHERE a.session_id=s.id AND a.method='recovery')
 AND (auth_session_is_strong(s.id) OR (
 NOT u.two_factor_enabled AND NOT EXISTS(SELECT 1 FROM auth_two_factors f WHERE f.user_id=s.user_id AND f.verified)
 AND NOT EXISTS(SELECT 1 FROM auth_passkeys p WHERE p.user_id=s.user_id))))
 );
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_session_can_access_workspace(target uuid, workspace uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
 RETURN (
 SELECT auth_session_can_access_content(target) AND EXISTS(
 SELECT 1 FROM auth_sessions s JOIN workspace_members m ON m.user_id=s.user_id AND m.workspace_id=workspace
 JOIN workspaces w ON w.id=m.workspace_id AND w.deleted_at IS NULL
 LEFT JOIN workspace_policies p ON p.workspace_id=w.id
 WHERE s.id=target AND m.role IN ('owner','member')
 AND (NOT coalesce(p.require_strong_auth,false) OR auth_session_is_strong(target)
 OR m.mfa_deadline>statement_timestamp()))
 );
END $$;
