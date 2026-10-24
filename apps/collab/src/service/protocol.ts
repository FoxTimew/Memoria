import { IncomingMessage } from '@hocuspocus/server';
import { z } from 'zod';
import { documentBytes } from './config.ts';
const id = z.uuid();
export function roomIdentity(name: string) {
  const parts = name.split(':');
  if (parts.length !== 3 || !parts.every((p) => id.safeParse(p).success))
    throw new Error('INVALID_ROOM');
  return { workspace: parts[0]!, page: parts[1]!, generation: parts[2]! };
}
/** Parse only the bounded envelope, never Yjs structures, on the ingress path. */
export function envelope(bytes: Uint8Array) {
  if (bytes.length > documentBytes + 65536) throw new Error('MESSAGE_TOO_LARGE');
  const m = new IncomingMessage(bytes),
    address = m.readVarString();
  if (address.length > 160) throw new Error('INVALID_ROOM');
  const name = address.split('\0')[0]!;
  roomIdentity(name);
  const type = m.readVarUint();
  if (type === 0 || type === 4) {
    const subtype = m.readVarUint();
    if (![0, 1, 2].includes(subtype)) throw new Error('INVALID_SYNC');
    const payload = m.readVarUint8Array();
    if (m.decoder.pos !== bytes.length) throw new Error('TRAILING_FRAME_DATA');
    if (payload.length > documentBytes) throw new Error('UPDATE_TOO_LARGE');
    return { address, name, type, update: subtype !== 0, payload };
  }
  if (type === 1) {
    const payload = m.readVarUint8Array();
    if (payload.length > 1024 || m.decoder.pos !== bytes.length)
      throw new Error('PRESENCE_TOO_LARGE');
    const state = new IncomingMessage(payload);
    if (state.readVarUint() !== 1) throw new Error('PRESENCE_ONE_CLIENT');
    if (!Number.isSafeInteger(state.readVarUint()) || !Number.isSafeInteger(state.readVarUint()))
      throw new Error('PRESENCE_INVALID_CLOCK');
    state.readVarString();
    if (state.decoder.pos !== payload.length) throw new Error('PRESENCE_TRAILING_DATA');
    return { address, name, type, update: false };
  }
  if (![2, 3, 7].includes(type)) throw new Error('MESSAGE_UNSUPPORTED');
  if (bytes.length > 32768) throw new Error('HANDSHAKE_TOO_LARGE');
  return { address, name, type, update: false };
}
