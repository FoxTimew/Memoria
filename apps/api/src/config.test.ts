import { describe, expect, it } from 'vitest';
import { readConfig } from './config.ts';

const environment = {
  NODE_ENV: 'test',
  APP_ORIGIN: 'https://localhost',
  BETTER_AUTH_SECRET: 'only-for-config-validation-not-a-credential',
  DATABASE_URL: 'postgresql://localhost/memoria',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  SMTP_FROM: 'test@example.test',
};

describe('runtime configuration', () => {
  it('requires HTTPS and never prints a rejected credential value', () => {
    const invalid = {
      ...environment,
      APP_ORIGIN: 'http://localhost',
      BETTER_AUTH_SECRET: 'private-value',
    };
    expect(() => readConfig(invalid)).toThrow('APP_ORIGIN');
    expect(() => readConfig(invalid)).not.toThrow('private-value');
  });
  it('requires explicit production proxy and SMTP configuration', () => {
    expect(() => readConfig({ ...environment, NODE_ENV: 'production' })).toThrow(
      'TRUSTED_PROXY_CIDRS',
    );
    expect(() => readConfig({ ...environment, SMTP_HOST: '' })).toThrow('SMTP_HOST');
    expect(() => readConfig({ ...environment, SMTP_USER: 'configured-without-password' })).toThrow(
      'configured together',
    );
  });
});
