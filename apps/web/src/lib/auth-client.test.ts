import { describe, expect, it } from 'vitest';
import { authError } from './auth-client.ts';

describe('authentication errors', () => {
  it('recognizes Better Auth rate limits even without a business error code', () => {
    expect(authError(undefined, 429)).toContain('Trop de tentatives');
    expect(authError('TOO_MANY_REQUESTS')).toBe(authError(undefined, 429));
  });
  it('keeps the email verification instruction for an ordinary auth rejection', () => {
    expect(authError('EMAIL_NOT_VERIFIED', 403)).toContain('Vérifiez votre adresse email');
  });
});
