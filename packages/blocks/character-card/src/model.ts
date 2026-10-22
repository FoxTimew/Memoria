import { z } from 'zod';

export const characterCardV1Schema = z.strictObject({
  characterId: z.uuid(),
  name: z.string().max(120),
  description: z.string().max(10000),
});
export const characterCardSchema = z.strictObject({
  characterId: z.uuid(),
  displayName: z.string().max(120),
  archetype: z.enum(['player', 'npc', 'enemy']),
  biography: z.string().max(10000),
  health: z.int().min(0).max(100000),
  attack: z.int().min(0).max(100000),
  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(16)
    .refine((tags) => new Set(tags).size === tags.length, 'Tags must be unique'),
});
export type CharacterCard = z.infer<typeof characterCardSchema>;

export function migrateCharacterCard(data: unknown, fromVersion: number): CharacterCard {
  if (fromVersion === 2) return characterCardSchema.parse(data);
  if (fromVersion !== 1) throw new Error(`Unsupported character-card version: ${fromVersion}`);
  const previous = characterCardV1Schema.parse(data);
  return characterCardSchema.parse({
    characterId: previous.characterId,
    displayName: previous.name,
    biography: previous.description,
    archetype: 'npc',
    health: 100,
    attack: 10,
    tags: [],
  });
}

export function characterCardToPlainText(data: CharacterCard): string {
  const card = characterCardSchema.parse(data);
  return [
    card.displayName,
    card.archetype,
    card.biography,
    `Health: ${card.health}`,
    `Attack: ${card.attack}`,
    card.tags.join(', '),
  ]
    .filter(Boolean)
    .join('\n');
}
