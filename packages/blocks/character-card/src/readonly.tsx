import type { ReactElement } from 'react';
import { characterCardSchema } from './model.ts';
import type { CharacterCard } from './model.ts';

export default function CharacterCardReadonly({ data }: { data: CharacterCard }): ReactElement {
  const card = characterCardSchema.parse(data);
  return (
    <article aria-label="Character card">
      <h3>{card.displayName || 'Unnamed character'}</h3>
      <p>{card.archetype}</p>
      <p style={{ whiteSpace: 'pre-wrap' }}>{card.biography}</p>
      <dl>
        <dt>Health</dt>
        <dd>{card.health}</dd>
        <dt>Attack</dt>
        <dd>{card.attack}</dd>
      </dl>
      {card.tags.length > 0 && (
        <ul>
          {card.tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      )}
      <small>Engine ID: {card.characterId}</small>
    </article>
  );
}
