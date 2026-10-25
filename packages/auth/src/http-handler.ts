import type { Database } from '@memoria/db';
import { createAuth } from './create-auth.ts';
import type { AuthOptions } from './create-auth.ts';

class FailedAuthTransaction extends Error {}

/** No response headers/cookie leave the server before the security transaction commits. */
export async function handleAuthRequest(
  database: Database,
  options: AuthOptions,
  request: Request,
): Promise<Response> {
  try {
    return await database.transaction(async (transaction) => {
      const auth = createAuth(transaction, { ...options, securityFlow: {} });
      const response = await auth.handler(request);
      // Library error handlers return HTTP responses; force SQL rollback on an internal failure.
      if (response.status >= 500) throw new FailedAuthTransaction();
      return response;
    });
  } catch {
    return Response.json(
      { code: 'AUTH_TRANSACTION_FAILED', message: 'Réessayez la connexion.' },
      { status: 500 },
    );
  }
}
