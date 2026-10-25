-- A verified factor belongs to a specific live session and account security generation.
CREATE FUNCTION auth_session_is_strong(target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
 JOIN session_assurance a ON a.session_id=s.id LEFT JOIN account_security sec ON sec.user_id=s.user_id
 WHERE s.id=target AND s.expires_at>statement_timestamp() AND u.email_verified
 AND a.security_version=coalesce(sec.version,0) AND a.verified_at<=statement_timestamp()
 AND ((a.method='totp' AND EXISTS(SELECT 1 FROM auth_two_factors f WHERE f.id=a.factor_id AND f.user_id=s.user_id AND f.verified AND u.two_factor_enabled))
 OR (a.method='passkey' AND EXISTS(SELECT 1 FROM auth_passkeys p WHERE p.id=a.factor_id AND p.user_id=s.user_id))))
$$;
--> statement-breakpoint
CREATE FUNCTION auth_session_can_access_content(target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
 WHERE s.id=target AND s.expires_at>statement_timestamp() AND u.email_verified
 AND NOT EXISTS(SELECT 1 FROM session_assurance a WHERE a.session_id=s.id AND a.method='recovery')
 AND (auth_session_is_strong(s.id) OR (
 NOT u.two_factor_enabled AND NOT EXISTS(SELECT 1 FROM auth_two_factors f WHERE f.user_id=s.user_id AND f.verified)
 AND NOT EXISTS(SELECT 1 FROM auth_passkeys p WHERE p.user_id=s.user_id))))
$$;
