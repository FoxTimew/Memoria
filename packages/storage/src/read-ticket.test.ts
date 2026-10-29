import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ReadTickets } from './read-ticket.ts';
import type { FileReadClaim } from '@memoria/db';
const claim: FileReadClaim = {
  user: 'user-secret',
  session: 'session-secret',
  workspace: randomUUID(),
  page: randomUUID(),
  file: randomUUID(),
  usage: randomUUID(),
  generation: randomUUID(),
  database: null,
  lifecycle: null,
  accessVersion: 1,
  fileVersion: 1,
  variant: 'original',
};
it('opaque, authenticated, 60 second ticket; fails after rotation and alteration', () => {
  const t = new ReadTickets('a'.repeat(32)),
    token = t.issue(claim, 100000);
  expect(t.open(token, 100001)).toEqual(claim);
  expect(Buffer.from(token, 'base64url').includes(Buffer.from(claim.session))).toBe(false);
  for (const bad of [
    token.slice(0, 30) + '!' + token.slice(31),
    token.slice(0, -1),
    token.slice(0, 50) + (token[50] === 'A' ? 'B' : 'A') + token.slice(51),
  ])
    expect(() => t.open(bad, 100001)).toThrow('INVALID_FILE_TICKET');
  expect(() => t.open(token, 160000)).toThrow('INVALID_FILE_TICKET');
  expect(() => new ReadTickets('b'.repeat(32)).open(token, 100001)).toThrow('INVALID_FILE_TICKET');
});
