import { z } from 'zod';
const palette = [
  '#35689a',
  '#8c477c',
  '#397854',
  '#ad5d2b',
  '#6655a3',
  '#247c83',
  '#a94755',
  '#7c7132',
];
export function presenceUser(id: string, name: string) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return {
    id,
    name: name.trim().slice(0, 120) || 'Membre',
    color: palette[(hash >>> 0) % palette.length]!,
  };
}
const yid = z.strictObject({
  client: z.number().int().nonnegative().safe(),
  clock: z.number().int().nonnegative().safe(),
});
const position = z.strictObject({
  type: yid.nullable().optional(),
  tname: z.string().max(64).nullable().optional(),
  item: yid.nullable().optional(),
  assoc: z.number().int().min(-1).max(1).optional(),
});
export const presenceInputSchema = z.strictObject({
  user: z.unknown().optional(),
  cursor: z.strictObject({ anchor: position, head: position }).nullable().optional(),
});
export const presenceUserSchema = z.strictObject({
  id: z.string().max(128),
  name: z.string().max(120),
  color: z.enum(palette as [string, ...string[]]),
});
