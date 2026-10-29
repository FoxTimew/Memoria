'use client';
import { useEffect, useState } from 'react';
import { ContentError } from '../lib/content-api.ts';
import { databaseRequest, displayValue, referenceDelta } from '../lib/database-ui.ts';
import type { Cell, CellValue, Option, Property } from '../lib/database-ui.ts';
import { DatabaseValue, selectedIds } from './database-value.tsx';
import { FileCard, FileUpload } from './files.tsx';

export function DatabaseCell({
  endpoint,
  row,
  property,
  options,
  close,
  saved,
  readOnly = false,
}: {
  endpoint: string;
  row: string;
  property: Property;
  options: Option[];
  close: () => void;
  saved: () => void;
  readOnly?: boolean;
}) {
  const path = `${endpoint}/rows/${row}/cells/${property.id}`;
  const [base, setBase] = useState<Cell>(),
    [draft, setDraft] = useState<CellValue>(null),
    [remote, setRemote] = useState<Cell>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [original, setOriginal] = useState<CellValue>(null);
  const [fileBusy, setFileBusy] = useState(false);
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
    if (!base || readOnly || fileBusy) return;
    setBusy(true);
    setError('');
    try {
      const value = ['person', 'relation', 'files'].includes(property.kind)
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
      <p>
        {readOnly
          ? 'Lecture seule : vous pouvez consulter les fichiers, sans en ajouter ni en retirer.'
          : 'La cellule est enregistrée uniquement à votre confirmation.'}
      </p>
      {base && (
        <fieldset disabled={busy}>
          {property.kind === 'files' ? (
            <>
              {draft && typeof draft === 'object' && 'items' in draft && (
                <>
                  {draft.items.map((item) => (
                    <div key={item.id}>
                      {selectedIds(original).includes(item.id) ? (
                        <FileCard id={item.id} />
                      ) : (
                        <p>{item.name} · À joindre à la confirmation</p>
                      )}
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              items: draft.items.filter((i) => i.id !== item.id),
                            })
                          }
                        >
                          Retirer {item.name}
                        </button>
                      )}
                    </div>
                  ))}
                  {draft.hasHidden && (
                    <p>Certains fichiers ne sont pas accessibles. Ces liens seront conservés.</p>
                  )}
                </>
              )}
              {!readOnly && (
                <FileUpload
                  onBusy={setFileBusy}
                  onReady={(id, name) =>
                    setDraft((old) => {
                      const value =
                        old && typeof old === 'object' && 'items' in old
                          ? old
                          : { items: [], hasHidden: false };
                      return {
                        ...value,
                        items: [...value.items.filter((i) => i.id !== id), { id, name }],
                      };
                    })
                  }
                />
              )}
            </>
          ) : (
            <DatabaseValue
              property={property}
              value={draft}
              onChange={setDraft}
              endpoint={endpoint}
            />
          )}
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
        {!readOnly && (
          <button
            disabled={busy || fileBusy || !base || !!remote}
            className="primary"
            onClick={() => void save()}
          >
            Enregistrer la cellule
          </button>
        )}
        <button disabled={busy} className="quiet-link" onClick={close}>
          Annuler
        </button>
      </div>
      {base && ['person', 'relation', 'files'].includes(property.kind) && (
        <p>Les liens que vous ne pouvez pas consulter ne sont jamais supprimés ici.</p>
      )}
    </section>
  );
}
