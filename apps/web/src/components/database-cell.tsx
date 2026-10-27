'use client';
import { useEffect, useState } from 'react';
import { ContentError } from '../lib/content-api.ts';
import { databaseRequest, displayValue, referenceDelta } from '../lib/database-ui.ts';
import type { Cell, CellValue, Option, Property } from '../lib/database-ui.ts';
import { DatabaseValue, selectedIds } from './database-value.tsx';

export function DatabaseCell({
  endpoint,
  row,
  property,
  options,
  close,
  saved,
}: {
  endpoint: string;
  row: string;
  property: Property;
  options: Option[];
  close: () => void;
  saved: () => void;
}) {
  const path = `${endpoint}/rows/${row}/cells/${property.id}`;
  const [base, setBase] = useState<Cell>(),
    [draft, setDraft] = useState<CellValue>(null),
    [remote, setRemote] = useState<Cell>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [original, setOriginal] = useState<CellValue>(null);
  useEffect(() => {
    let active = true;
    void databaseRequest<Cell>(path)
      .then((c) => {
        if (active) {
          setBase(c);
          setOriginal(c.value);
          setDraft(c.value);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [path]);
  async function save() {
    if (!base) return;
    setBusy(true);
    setError('');
    try {
      const value = ['person', 'relation'].includes(property.kind)
        ? referenceDelta(original, selectedIds(draft))
        : draft;
      await databaseRequest(path, 'PATCH', {
        expectedSchemaVersion: base.schemaVersion,
        expectedCellVersion: base.version,
        value,
      });
      saved();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cellule non enregistrée.');
      if (e instanceof ContentError && e.code === 'CELL_VERSION_CONFLICT') {
        try {
          setRemote(await databaseRequest<Cell>(path));
        } catch {
          setError(
            'Votre saisie est conservée, mais la valeur actuelle ne peut pas être chargée. Réessayez en ligne.',
          );
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label={`Modifier ${property.name}`}
      className="database-dialog"
    >
      <h2 className="text-lg font-semibold">{property.name}</h2>
      <p>La cellule est enregistrée uniquement à votre confirmation.</p>
      {base && (
        <fieldset disabled={busy}>
          <DatabaseValue
            property={property}
            value={draft}
            onChange={setDraft}
            endpoint={endpoint}
          />
        </fieldset>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {remote && (
        <div role="alert" className="notice">
          <p>Valeur actuelle : {displayValue(remote.value, property, options)}.</p>
          <p>Votre saisie est conservée ci-dessus.</p>
          <button
            className="quiet-link mr-4"
            onClick={() => {
              setBase(remote);
              setOriginal(remote.value);
              setDraft(remote.value);
              setRemote(undefined);
              setError('');
            }}
          >
            Utiliser la valeur actuelle
          </button>
          <button
            className="quiet-link"
            onClick={() => {
              setBase(remote);
              setRemote(undefined);
              setError('');
            }}
          >
            Garder ma saisie pour la réappliquer
          </button>
        </div>
      )}
      <div className="flex gap-3">
        <button
          disabled={busy || !base || !!remote}
          className="primary"
          onClick={() => void save()}
        >
          Enregistrer la cellule
        </button>
        <button disabled={busy} className="quiet-link" onClick={close}>
          Annuler
        </button>
      </div>
      {base && ['person', 'relation'].includes(property.kind) && (
        <p>Les liens que vous ne pouvez pas consulter ne sont jamais supprimés ici.</p>
      )}
    </section>
  );
}
