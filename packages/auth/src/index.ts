export { createAuth } from './create-auth.ts';
export type { Auth, AuthOptions } from './create-auth.ts';
export { handleAuthRequest } from './http-handler.ts';
export { readAssurance } from './assurance.ts';
export { lockSession, requireSensitiveAction, SecurityPolicyError } from './workspace-security.ts';
export type { SessionIdentity, SensitiveAction } from './workspace-security.ts';
export { operatorReset } from './recovery-core.ts';
export { processAuthMail } from './mail-jobs.ts';
