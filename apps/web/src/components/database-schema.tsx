'use client';
import { useEffect, useState } from 'react';
import { databaseRequest, kinds } from '../lib/database-ui.ts';
import type { Base, BaseSummary, Kind, Property, Choice } from '../lib/database-ui.ts';
import { DatabaseChoices } from './database-value.tsx';
import { ContentError } from '../lib/content-api.ts';
import { securityDestination } from '../lib/access-flow.ts';

export function DatabaseSchema({
  base,
  endpoint,
  databases,
  saved,
  managePeople,
}: {
  base: Base;
  endpoint: string;
  databases: BaseSummary[];
  saved: () => void;
  managePeople: boolean;
}) {
  const [editing, setEditing] = useState<Property>(),
    [name, setName] = useState(''),
    [kind, setKind] = useState<Kind>('text'),
    [target, setTarget] = useState(''),
    [mode, setMode] = useState('date'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [option, setOption] = useState(''),
    [optionId, setOptionId] = useState<string>(),
    [security, setSecurity] = useState(false);
  const [people, setPeople] = useState<Choice[]>([]),
    [selected, setSelected] = useState<string[]>([]);
  const person = base.properties.find((p) => p.kind === 'person');
  useEffect(() => {
    if (!managePeople) return;
    let active = true;
    void databaseRequest<{ people: Choice[] }>(`${endpoint}/assignable-people`)
      .then((r) => {
        if (active) {
          setPeople(r.people);
          setSelected(r.people.map((p) => p.id));
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [endpoint, base.schema_version, managePeople]);
  async function mutate(path: string, method: string, body: object) {
    setBusy(true);
    setError('');
    setSecurity(false);
    try {
      await databaseRequest(path, method, { expectedSchemaVersion: base.schema_version, ...body });
      saved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Modification impossible.');
      if (e instanceof ContentError && e.code === 'RECENT_STRONG_AUTH_REQUIRED') setSecurity(true);
    } finally {
      setBusy(false);
    }
  }
  function choose(p?: Property) {
    setEditing(p);
    setName(p?.name ?? '');
    setKind(p?.kind ?? 'text');
    setMode(p?.config.mode ?? 'date');
    setTarget(p?.relation_target_database_id ?? '');
    setOption('');
    setOptionId(undefined);
  }
  return (
    <section aria-label="Gestion des colonnes" className="notice grid gap-3">
      <h2 className="font-semibold">Colonnes de la base</h2>
      <fieldset disabled={busy} className="grid gap-3">
        <label>
          Propriété à modifier
          <select
            className="field"
            value={editing?.id ?? ''}
            onChange={(e) => choose(base.properties.find((p) => p.id === e.target.value))}
          >
            <option value="">Nouvelle propriété</option>
            {base.properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Nom de la propriété
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
          />
        </label>
        <label>
          Type
          <select className="field" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {Object.entries(kinds).map(([k, label]) => (
              <option value={k} key={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {kind === 'date' && (
          <label>
            Précision
            <select className="field" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="date">Date civile</option>
              <option value="instant">Date et heure avec fuseau</option>
            </select>
          </label>
        )}
        {kind === 'relation' && (
          <label>
            Base cible
            <select className="field" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choisir une base accessible</option>
              {databases.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title || 'Sans titre'}
                </option>
              ))}
            </select>
          </label>
        )}
        <p>
          Le type, la précision d’une date ou la base cible ne peuvent changer que si la colonne est
          vide.
        </p>
        <button
          className="primary"
          disabled={!name.trim() || (kind === 'relation' && !target)}
          onClick={() =>
            void mutate(
              `${endpoint}/properties${editing ? '/' + editing.id : ''}`,
              editing ? 'PATCH' : 'POST',
              {
                name,
                kind,
                config: kind === 'date' ? { mode } : {},
                targetDatabaseId: kind === 'relation' ? target : null,
              },
            )
          }
        >
          {editing ? 'Enregistrer la propriété' : 'Créer la propriété'}
        </button>
        {editing && (
          <button
            onClick={() => {
              if (
                confirm(
                  'Retirer cette colonne du tableau ? Ses valeurs seront conservées dans la corbeille technique.',
                )
              )
                void mutate(`${endpoint}/properties/${editing.id}`, 'PATCH', {
                  archived: true,
                }).then(() => choose());
            }}
          >
            Retirer la propriété
          </button>
        )}
        {editing && ['select', 'multi_select'].includes(editing.kind) && (
          <section aria-label="Options de la propriété">
            <h3>Choix proposés</h3>
            <ul>
              {base.options
                .filter((o) => o.property_id === editing.id)
                .map((o) => (
                  <li key={o.id}>
                    {o.label}
                    {o.deleted_at ? ' (retiré)' : ''}{' '}
                    <button
                      onClick={() => {
                        setOption(o.label);
                        setOptionId(o.id);
                      }}
                    >
                      Renommer {o.label}
                    </button>{' '}
                    <button
                      onClick={() =>
                        void mutate(
                          `${endpoint}/properties/${editing.id}/options/${o.id}`,
                          'PATCH',
                          { archived: !o.deleted_at },
                        )
                      }
                    >
                      {o.deleted_at ? 'Restaurer' : 'Retirer'} {o.label}
                    </button>
                  </li>
                ))}
            </ul>
            <label>
              Libellé du choix
              <input className="field" value={option} onChange={(e) => setOption(e.target.value)} />
            </label>
            <button
              disabled={!option.trim()}
              onClick={() =>
                void mutate(
                  `${endpoint}/properties/${editing.id}/options${optionId ? '/' + optionId : ''}`,
                  optionId ? 'PATCH' : 'POST',
                  { label: option },
                ).then(() => {
                  setOption('');
                  setOptionId(undefined);
                })
              }
            >
              {optionId ? 'Enregistrer le choix' : 'Ajouter le choix'}
            </button>
            {optionId && (
              <button
                onClick={() => {
                  setOptionId(undefined);
                  setOption('');
                }}
              >
                Nouveau choix
              </button>
            )}
          </section>
        )}
      </fieldset>
      {managePeople && person && (
        <fieldset disabled={busy}>
          <legend>Personnes proposées aux invités de cette base</legend>
          <DatabaseChoices
            endpoint={`${endpoint}/properties/${person.id}/choices`}
            selected={selected}
            onChange={setSelected}
            initial={people}
          />
          <button
            onClick={() =>
              void mutate(`${endpoint}/assignable-people`, 'PUT', { people: selected })
            }
          >
            Enregistrer les personnes proposées
          </button>
          <p>
            Un invité voit ces noms et le sien, sans annuaire ni adresse email. Une vérification
            récente de votre identité est nécessaire.
          </p>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {security && (
        <a href={securityDestination(location.pathname)}>
          Configurer ou vérifier ma connexion forte, puis revenir
        </a>
      )}
    </section>
  );
}
