'use client';
import { useState } from 'react';
import type { DatabaseQuery } from '@memoria/contracts';
import { operators } from '../lib/database-ui.ts';
import type { Property } from '../lib/database-ui.ts';
import { DatabaseChoices } from './database-value.tsx';
const labels = {
  eq: 'Est égal à',
  ne: 'Est différent de',
  lt: 'Avant / inférieur à',
  lte: 'Inférieur ou égal à',
  gt: 'Après / supérieur à',
  gte: 'Supérieur ou égal à',
  between: 'Est compris entre',
  contains: 'Contient',
  startsWith: 'Commence par',
  in: 'Est un des choix',
  any: 'Contient une des valeurs',
  empty: 'Est vide',
  notEmpty: 'N’est pas vide',
};
export function DatabaseQueryPanel({
  properties,
  endpoint,
  initial,
  apply,
  canSave,
  save,
}: {
  properties: Property[];
  endpoint: string;
  initial: DatabaseQuery;
  apply: (q: DatabaseQuery) => void;
  canSave: boolean;
  save: (q: DatabaseQuery) => void;
}) {
  const [q, setQ] = useState<DatabaseQuery>({ filters: initial.filters, sorts: initial.sorts });
  const fields = [
    { id: 'title', name: 'Titre', kind: 'text', config: {} } as Property,
    ...properties,
  ];
  const changeFilter = (index: number, patch: Partial<DatabaseQuery['filters'][number]>) =>
    setQ((old) => ({
      ...old,
      filters: old.filters.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    }));
  return (
    <section aria-label="Tri et filtres" className="notice grid gap-3">
      <h2>Afficher les lignes qui correspondent à tous les filtres</h2>
      {q.filters.map((f, i) => {
        const p = fields.find((p) => p.id === f.field)!;
        return (
          <fieldset key={i} className="flex flex-wrap gap-2 border p-2">
            <legend>Filtre {i + 1}</legend>
            <select
              aria-label={`Colonne du filtre ${i + 1}`}
              value={f.field}
              onChange={(e) => {
                const p = fields.find((p) => p.id === e.target.value)!;
                changeFilter(i, { field: p.id, op: 'empty', value: undefined });
              }}
            >
              {fields.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              aria-label={`Opérateur du filtre ${i + 1}`}
              value={f.op}
              onChange={(e) =>
                changeFilter(i, { op: e.target.value as typeof f.op, value: undefined })
              }
            >
              {operators(p.kind).map((op) => (
                <option value={op} key={op}>
                  {labels[op]}
                </option>
              ))}
            </select>
            {!['empty', 'notEmpty'].includes(f.op) &&
              (['person', 'relation', 'select', 'multi_select'].includes(p.kind) ? (
                <DatabaseChoices
                  endpoint={`${endpoint}/properties/${p.id}/choices`}
                  selected={Array.isArray(f.value) ? (f.value as string[]) : []}
                  onChange={(ids) => changeFilter(i, { value: ids })}
                />
              ) : p.kind === 'checkbox' ? (
                <select
                  aria-label={`Valeur du filtre ${i + 1}`}
                  value={String(f.value ?? '')}
                  onChange={(e) => changeFilter(i, { value: e.target.value === 'true' })}
                >
                  <option value="" disabled>
                    Choisir
                  </option>
                  <option value="true">Oui</option>
                  <option value="false">Non</option>
                </select>
              ) : f.op === 'between' ? (
                <>
                  {[0, 1].map((n) => (
                    <input
                      key={n}
                      aria-label={`${n ? 'Maximum' : 'Minimum'} du filtre ${i + 1}`}
                      className="field"
                      type={p.kind === 'date' && p.config.mode !== 'instant' ? 'date' : 'text'}
                      value={Array.isArray(f.value) ? String(f.value[n] ?? '') : ''}
                      onChange={(e) => {
                        const v = Array.isArray(f.value) ? [...f.value] : ['', ''];
                        v[n] = e.target.value;
                        changeFilter(i, { value: v });
                      }}
                    />
                  ))}
                </>
              ) : (
                <input
                  className="field"
                  aria-label={`Valeur du filtre ${i + 1}`}
                  type={p.kind === 'date' && p.config.mode !== 'instant' ? 'date' : 'text'}
                  placeholder={p.config.mode === 'instant' ? 'Date ISO avec fuseau' : ''}
                  value={String(f.value ?? '')}
                  onChange={(e) => changeFilter(i, { value: e.target.value })}
                />
              ))}
            <button
              onClick={() =>
                setQ((old) => ({ ...old, filters: old.filters.filter((_, j) => i !== j) }))
              }
            >
              Retirer le filtre {i + 1}
            </button>
          </fieldset>
        );
      })}
      <button
        disabled={q.filters.length >= 10}
        className="quiet-link"
        onClick={() =>
          setQ((old) => ({
            ...old,
            filters: [...old.filters, { field: 'title', op: 'contains', value: '' }],
          }))
        }
      >
        Ajouter un filtre
      </button>
      {q.sorts.map((sort, i) => (
        <div key={i} className="flex gap-2">
          <label>
            Tri {i + 1}
            <select
              value={sort.field}
              onChange={(e) =>
                setQ((old) => ({
                  ...old,
                  sorts: old.sorts.map((s, j) => (i === j ? { ...s, field: e.target.value } : s)),
                }))
              }
            >
              {fields
                .filter((p) => !['person', 'relation', 'multi_select'].includes(p.kind))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <select
            aria-label={`Sens du tri ${i + 1}`}
            value={sort.direction}
            onChange={(e) =>
              setQ((old) => ({
                ...old,
                sorts: old.sorts.map((s, j) =>
                  i === j ? { ...s, direction: e.target.value as 'asc' | 'desc' } : s,
                ),
              }))
            }
          >
            <option value="asc">Croissant</option>
            <option value="desc">Décroissant</option>
          </select>
          <button
            onClick={() => setQ((old) => ({ ...old, sorts: old.sorts.filter((_, j) => i !== j) }))}
          >
            Retirer le tri {i + 1}
          </button>
        </div>
      ))}
      <button
        className="quiet-link"
        disabled={q.sorts.length >= 2}
        onClick={() =>
          setQ((old) => ({ ...old, sorts: [...old.sorts, { field: 'title', direction: 'asc' }] }))
        }
      >
        Ajouter un tri
      </button>
      <div className="flex gap-3">
        <button className="primary" onClick={() => apply(q)}>
          Appliquer à mon affichage
        </button>
        {canSave && <button onClick={() => save(q)}>Enregistrer la vue commune</button>}
      </div>
      <p>
        Les filtres de personnes et de relations portent uniquement sur les valeurs accessibles. Les
        dates filtrent le début de la période. Les cases vides sont distinctes de « Non ».
      </p>
    </section>
  );
}
