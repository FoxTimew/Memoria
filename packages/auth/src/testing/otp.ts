import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
export function testOtp(uri: string) {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error('Test TOTP secret missing');
  return createOTP(Buffer.from(base32.decode(secret)).toString('utf8'), { digits: 6, period: 30 });
}
