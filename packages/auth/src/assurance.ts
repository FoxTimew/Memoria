import { sql } from 'drizzle-orm';
import type { Database, WriteTransaction } from '@memoria/db';

export async function readAssurance(db: Database | WriteTransaction, sessionId: string) {
  const result = await db.execute<{
    strong: boolean;
    content: boolean;
    method: string | null;
    verified_at: Date | null;
  }>(sql`SELECT auth_session_is_strong(${sessionId}::uuid) AS strong,
    auth_session_can_access_content(${sessionId}::uuid) AS content,
    a.method, a.verified_at FROM auth_sessions s LEFT JOIN session_assurance a ON a.session_id=s.id
    WHERE s.id=${sessionId}::uuid AND s.expires_at>clock_timestamp()`);
  const row = result.rows[0];
  return {
    strong: row?.strong === true,
    content: row?.content === true,
    method: row?.method ?? null,
    verifiedAt: row?.verified_at ? new Date(row.verified_at) : null,
    recent:
      row?.strong === true &&
      !!row.verified_at &&
      Date.now() - new Date(row.verified_at).getTime() < 600000,
  };
}
