'use client';
import { useEffect, useRef, useState } from 'react';
import { pageDocumentSchema, pageSaveResultSchema, pageVersionSchema } from '@memoria/contracts';
import { ContentError, contentRequest } from '../lib/content-api.ts';

export function PageTitle({
  title,
  version,
  endpoint,
  disabled,
  onDirty,
  onSaved,
  onValue,
}: {
  title: string;
  version: number;
  endpoint: string;
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
  onSaved: () => void;
  onValue: (value: string) => void;
}) {
  const [value, setValue] = useState(title),
    [base, setBase] = useState({ title, version });
  const [remote, setRemote] = useState<{ title: string; version: number }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const dirty = value !== base.title;
  const current = useRef({ dirty, busy, base });
  current.current = { dirty, busy, base };
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => onValue(value), [value, onValue]);
  useEffect(() => {
    let active = true;
    async function check() {
      if (current.current.busy) return;
      try {
        const next = pageVersionSchema.parse(await contentRequest(`${endpoint}/version`));
        if (!active || next.version === current.current.base.version) return;
        const data = pageDocumentSchema.parse(await contentRequest(endpoint));
        if (!active || current.current.busy || data.page.version <= current.current.base.version)
          return;
        const changed = { title: data.page.title, version: data.page.version };
        if (current.current.dirty) setRemote(changed);
        else {
          setBase(changed);
          setValue(changed.title);
          setRemote(undefined);
        }
      } catch {
        /* Saving reports failures; a polling failure never discards the title. */
      }
    }
    const interval = setInterval(() => void check(), 15000);
    globalThis.addEventListener('focus', check);
    return () => {
      active = false;
      clearInterval(interval);
      globalThis.removeEventListener('focus', check);
    };
  }, [endpoint]);
  async function save() {
    setBusy(true);
    setError('');
    const captured = value;
    try {
      const result = pageSaveResultSchema.parse(
        await contentRequest(`${endpoint}/rename`, 'POST', {
          expectedVersion: base.version,
          title: captured,
        }),
      );
      setBase({ title: captured, version: result.version });
      setRemote(undefined);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Titre non enregistré.');
      if (e instanceof ContentError && e.status === 409) {
        try {
          const data = pageDocumentSchema.parse(await contentRequest(endpoint));
          setRemote({ title: data.page.title, version: data.page.version });
        } catch {
          /* Keep the conflict and retry explicitly. */
        }
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Titre de la page">
      <input
        aria-label="Titre de la page"
        className="page-title"
        maxLength={500}
        value={value}
        disabled={disabled || busy}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="px-6 pb-3 text-sm">
        <button
          className="quiet-link"
          disabled={!dirty || busy || disabled || !!remote}
          onClick={() => void save()}
        >
          {busy ? 'Enregistrement du titre…' : 'Enregistrer le titre'}
        </button>
        {dirty && <span className="ml-3">Titre non enregistré</span>}
        {error && (
          <p role="alert" className="notice error mt-2">
            {error}
          </p>
        )}
        {remote && (
          <div role="alert" className="notice mt-2">
            <p>La page a changé ailleurs. Titre actuel : « {remote.title || 'Sans titre'} ».</p>
            <button
              className="quiet-link mr-4"
              onClick={() => {
                setBase(remote);
                setValue(remote.title);
                setRemote(undefined);
                setError('');
              }}
            >
              Utiliser le titre serveur
            </button>
            <button
              className="quiet-link"
              onClick={() => {
                setBase(remote);
                setRemote(undefined);
                setError('');
              }}
            >
              Garder mon titre pour le réenregistrer
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
