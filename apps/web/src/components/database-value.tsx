'use client';
import { useEffect, useState } from 'react';
import { choiceLabel, databaseRequest } from '../lib/database-ui.ts';
import type { CellValue, Choice, Property } from '../lib/database-ui.ts';

export function DatabaseChoices({
  endpoint,
  selected,
  onChange,
  initial = [],
}: {
  endpoint: string;
  selected: string[];
  onChange: (ids: string[]) => void;
  initial?: Choice[];
}) {
  const [q, setQ] = useState(''),
    [choices, setChoices] = useState<Choice[]>([]),
    [known, setKnown] = useState(initial),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setBusy(true);
    const timer = setTimeout(() => {
      void databaseRequest<{ items: Choice[]; cursor: string | null }>(endpoint, 'POST', { q })
        .then((result) => {
          if (!active) return;
          setChoices(result.items);
          setKnown((old) => [
            ...old.filter((c) => !result.items.some((n) => n.id === c.id)),
            ...result.items,
          ]);
          setCursor(result.cursor);
          setError('');
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [endpoint, q]);
  async function more() {
    setBusy(true);
    try {
      const next = await databaseRequest<{ items: Choice[]; cursor: string | null }>(
        endpoint,
        'POST',
        { q, cursor },
      );
      setChoices((old) => [...old, ...next.items]);
      setKnown((old) => [
        ...old.filter((c) => !next.items.some((n) => n.id === c.id)),
        ...next.items,
      ]);
      setCursor(next.cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-2">
      <label>
        Rechercher une valeur
        <input className="field" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div aria-label="Valeurs sélectionnées">
        {selected.map((id) => (
          <button
            type="button"
            className="quiet-link mr-3"
            key={id}
            onClick={() => onChange(selected.filter((x) => x !== id))}
          >
            Retirer {choiceLabel(known.find((c) => c.id === id) ?? { id, label: 'cette valeur' })}
          </button>
        ))}
      </div>
      <div aria-label="Valeurs disponibles" className="max-h-48 overflow-auto">
        {choices.map((c) => (
          <label className="block" key={c.id}>
            <input
              type="checkbox"
              checked={selected.includes(c.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id),
                )
              }
            />{' '}
            {choiceLabel(c)}
          </label>
        ))}
      </div>
      {!busy && !choices.length && <p>Aucune valeur disponible.</p>}
      {cursor && (
        <button type="button" disabled={busy} onClick={() => void more()}>
          Plus de valeurs
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function selectedIds(value: CellValue): string[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && 'items' in value) return value.items.map((c) => c.id);
  return typeof value === 'string' && value ? [value] : [];
}
export function DatabaseValue({
  property: p,
  value,
  onChange,
  endpoint,
}: {
  property: Property;
  value: CellValue;
  onChange: (v: CellValue) => void;
  endpoint: string;
}) {
  if (['select', 'multi_select', 'person', 'relation'].includes(p.kind))
    return (
      <>
        <DatabaseChoices
          endpoint={`${endpoint}/properties/${p.id}/choices`}
          selected={selectedIds(value)}
          initial={value && typeof value === 'object' && 'items' in value ? value.items : []}
          onChange={(ids) => onChange(p.kind === 'select' ? (ids.at(-1) ?? null) : ids)}
        />
        {value && typeof value === 'object' && 'hasHidden' in value && value.hasHidden && (
          <p>Certaines valeurs ne sont pas accessibles. Elles sont conservées.</p>
        )}
      </>
    );
  if (p.kind === 'checkbox')
    return (
      <label>
        Valeur
        <select
          aria-label="Valeur"
          className="field"
          value={value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}
        >
          <option value="">Vide</option>
          <option value="true">Oui</option>
          <option value="false">Non</option>
        </select>
      </label>
    );
  if (p.kind === 'date') {
    const date =
      value && typeof value === 'object' && 'start' in value ? value : { start: '', end: null };
    const instant = p.config.mode === 'instant';
    return (
      <div className="grid gap-2">
        <p>
          {instant
            ? 'Date et heure avec fuseau (ex. 2026-10-27T14:00:00+01:00).'
            : 'Date civile, sans fuseau horaire.'}
        </p>
        <label>
          Début
          <input
            className="field"
            type={instant ? 'text' : 'date'}
            value={date.start}
            onChange={(e) =>
              onChange(
                e.target.value
                  ? {
                      ...date,
                      start: e.target.value,
                      ...(instant ? { timeZone: date.timeZone ?? 'UTC' } : {}),
                    }
                  : null,
              )
            }
          />
        </label>
        <label>
          Fin (facultative)
          <input
            className="field"
            type={instant ? 'text' : 'date'}
            value={date.end ?? ''}
            onChange={(e) => onChange({ ...date, end: e.target.value || null })}
          />
        </label>
        {instant && (
          <label>
            Fuseau IANA
            <input
              className="field"
              value={date.timeZone ?? 'UTC'}
              onChange={(e) => onChange({ ...date, timeZone: e.target.value })}
            />
          </label>
        )}
      </div>
    );
  }
  return (
    <label>
      Valeur
      <input
        className="field"
        type={p.kind === 'url' ? 'url' : 'text'}
        inputMode={p.kind === 'number' ? 'decimal' : undefined}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || null)}
        placeholder={p.kind === 'number' ? 'Ex. 12.50 (point décimal)' : ''}
      />
    </label>
  );
}
