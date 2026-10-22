'use client';

import { createReactBlockSpec } from '@blocknote/react';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { fromEditorProps, toEditorProps } from './adapter.ts';
import { characterCardSchema } from './model.ts';
import type { CharacterCard } from './model.ts';

export { fromEditorProps, toEditorProps } from './adapter.ts';
export const editorType = 'gamedevCharacterCard';

function CharacterCardForm({
  value,
  disabled,
  onChange,
}: {
  value: CharacterCard;
  disabled: boolean;
  onChange: (next: CharacterCard) => void;
}): ReactElement {
  const [error, setError] = useState('');
  const update = (patch: Partial<CharacterCard>) => {
    const parsed = characterCardSchema.safeParse({ ...value, ...patch });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid character data');
      return;
    }
    setError('');
    onChange(parsed.data);
  };
  return (
    <fieldset disabled={disabled} contentEditable={false} aria-label="Character card">
      <legend>Character card</legend>
      <label>
        Name{' '}
        <input
          aria-label="Character name"
          value={value.displayName}
          maxLength={120}
          onChange={(event) => update({ displayName: event.target.value })}
        />
      </label>
      <label>
        Archetype{' '}
        <select
          value={value.archetype}
          onChange={(event) =>
            update({ archetype: characterCardSchema.shape.archetype.parse(event.target.value) })
          }
        >
          <option value="player">Player</option>
          <option value="npc">NPC</option>
          <option value="enemy">Enemy</option>
        </select>
      </label>
      <label>
        Biography{' '}
        <textarea
          value={value.biography}
          maxLength={10000}
          onChange={(event) => update({ biography: event.target.value })}
        />
      </label>
      <label>
        Health{' '}
        <input
          type="number"
          min={0}
          max={100000}
          value={value.health}
          onChange={(event) => update({ health: event.target.valueAsNumber })}
        />
      </label>
      <label>
        Attack{' '}
        <input
          type="number"
          min={0}
          max={100000}
          value={value.attack}
          onChange={(event) => update({ attack: event.target.valueAsNumber })}
        />
      </label>
      <label>
        Tags (comma separated){' '}
        <input
          key={value.characterId}
          defaultValue={value.tags.join(', ')}
          onBlur={(event) =>
            update({
              tags: [
                ...new Set(
                  event.target.value
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                ),
              ],
            })
          }
        />
      </label>
      <small>Engine ID: {value.characterId}</small>
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}

export const spec = createReactBlockSpec(
  {
    type: editorType,
    propSchema: { data: { default: '' } },
    content: 'none',
  },
  {
    render: ({ block, editor }) => {
      let value: CharacterCard;
      try {
        value = fromEditorProps(block.props);
      } catch {
        return (
          <p role="alert" contentEditable={false}>
            Invalid character card. Original data has been preserved.
          </p>
        );
      }
      return (
        <CharacterCardForm
          value={value}
          disabled={!editor.isEditable}
          onChange={(next) => editor.updateBlock(block, { props: toEditorProps(next) })}
        />
      );
    },
    toExternalHTML: ({ block }) => {
      const card = fromEditorProps(block.props);
      return (
        <article>
          <h3>{card.displayName}</h3>
          <p>{card.archetype}</p>
          <p>{card.biography}</p>
          <p>
            Health: {card.health} · Attack: {card.attack}
          </p>
          <p>{card.tags.join(', ')}</p>
        </article>
      );
    },
  },
)();
