import { once } from 'node:events';
export async function admitProofMeasurement() {
  if (!process.send) throw Error('Proof measurement requires the guarded parent runner');
  process.send({ kind: 'prepared' });
  const [m] = await once(process, 'message');
  if (m.kind !== 'start') throw Error('PROOF_MEASUREMENT_CANCELLED');
}
