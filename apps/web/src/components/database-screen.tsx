'use client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceListSchema } from '@memoria/contracts';
import type { DatabaseQuery } from '@memoria/contracts';
import { authClient } from '../lib/auth-client.ts';
import { ContentError, contentRequest } from '../lib/content-api.ts';
import { databaseRequest, displayValue, tableValue } from '../lib/database-ui.ts';
import type { Base, BaseSummary, Property, Row, Table } from '../lib/database-ui.ts';
import { refreshCachePolicy } from '../lib/cache-policy.ts';
import { CacheForbidden, LocalSessionRevoked } from '../lib/yjs-cache.ts';
import { onLocalSignOut } from '../lib/local-sign-out.ts';
import { DatabaseCell } from './database-cell.tsx';
import { DatabaseQueryPanel } from './database-query.tsx';
import { DatabaseSchema } from './database-schema.tsx';
import type { EditorActions } from './page-editor.tsx';
const PageEditor = dynamic(() => import('./page-editor.tsx'), { ssr: false });

export default function DatabaseScreen({
  workspaceId,
  databaseId,
  rowId,
}: {
  workspaceId: string;
  databaseId: string;
  rowId?: string;
}) {
  const { data: session, isPending } = authClient.useSession();
  const endpoint = `/api/internal/workspaces/${workspaceId}/databases/${databaseId}`,
    href = `/workspaces/${workspaceId}/databases/${databaseId}`;
  const [base, setBase] = useState<Base>(),
    [databases, setDatabases] = useState<BaseSummary[]>([]),
    [role, setRole] = useState('guest'),
    [table, setTable] = useState<Table>(),
    [row, setRow] = useState<Row>();
  const [query, setQuery] = useState<DatabaseQuery>({ filters: [], sorts: [] }),
    [history, setHistory] = useState<(string | undefined)[]>([undefined]),
    [pageSize, setPageSize] = useState(50),
    [reload, setReload] = useState(0);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [checking, setChecking] = useState(true),
    [revoked, setRevoked] = useState(false),
    [closed, setClosed] = useState(false),
    [exported, setExported] = useState('');
  const [cell, setCell] = useState<{ row: string; property: Property }>(),
    [schema, setSchema] = useState(false),
    [filters, setFilters] = useState(false),
    [hidden, setHidden] = useState<string[]>([]),
    [newTitle, setNewTitle] = useState(''),
    [trash, setTrash] = useState<{ items: Row[]; cursor: string | null }>();
  const actions = useRef<EditorActions | null>(null),
    epoch = useRef(0),
    ended = useRef(false);
  const receipt = useRef<string | undefined>(undefined);
  const close = useCallback(() => {
    ended.current = true;
    epoch.current++;
    setClosed(true);
    setBase(undefined);
    setTable(undefined);
    setRow(undefined);
    setCell(undefined);
    setExported('');
  }, []);
  const accessChanged = useCallback((snapshot: string) => {
    epoch.current++;
    setExported(snapshot);
    setRevoked(true);
    setBase(undefined);
    setRow(undefined);
    setTable(undefined);
    setCell(undefined);
  }, []);
  const saved = useCallback(() => setReload((n) => n + 1), []);
  const noDirty = useCallback(() => {}, []);
  useEffect(
    () => (session ? onLocalSignOut(session.user.id, close) : undefined),
    [session?.user.id, close],
  );
  // Relational values stay in memory only. A resumed tab hides them until rights are checked.
  useEffect(() => {
    if (!session || ended.current || revoked) return;
    let active = true,
      running = false;
    const freeze = () => {
      epoch.current++;
      setChecking(true);
    };
    const check = async (full = true) => {
      if (document.hidden || running) return;
      running = true;
      const captured = epoch.current;
      try {
        try {
          if (full) await refreshCachePolicy(session.user.id, session.session.id);
        } catch (e) {
          if (!(e instanceof CacheForbidden)) throw e;
        }
        const [b, listing, ws] = await Promise.all([
          databaseRequest<Base>(endpoint),
          full
            ? databaseRequest<{ databases: BaseSummary[] }>(
                `/api/internal/workspaces/${workspaceId}/databases`,
              )
            : undefined,
          full ? contentRequest('/api/internal/workspaces') : undefined,
        ]);
        if (!active || ended.current || captured !== epoch.current) return;
        setBase((old) => {
          if (old && (old.level !== b.level || old.canManageSchema !== b.canManageSchema)) {
            setCell(undefined);
            setSchema(false);
          }
          return b;
        });
        if (listing) setDatabases(listing.databases);
        if (ws)
          setRole(workspaceListSchema.parse(ws).find((w) => w.id === workspaceId)?.role ?? 'guest');
        setChecking(false);
        if (!rowId) setReload((n) => n + 1);
      } catch (e) {
        if (!active || captured !== epoch.current) return;
        if (e instanceof LocalSessionRevoked || (e instanceof ContentError && e.status === 401))
          close();
        else if (e instanceof ContentError && [403, 404].includes(e.status))
          accessChanged(actions.current?.export() ?? '');
        else setError(e instanceof Error ? e.message : 'Vérification indisponible.');
      } finally {
        running = false;
      }
    };
    const wake = () => {
      if (document.hidden) freeze();
      else {
        freeze();
        void check();
      }
    };
    void check();
    const timer = setInterval(() => void check(false), 15000);
    for (const event of ['focus', 'pageshow', 'online']) window.addEventListener(event, wake);
    document.addEventListener('visibilitychange', wake);
    document.addEventListener('freeze', freeze);
    document.addEventListener('resume', wake);
    return () => {
      active = false;
      clearInterval(timer);
      for (const event of ['focus', 'pageshow', 'online']) window.removeEventListener(event, wake);
      document.removeEventListener('visibilitychange', wake);
      document.removeEventListener('freeze', freeze);
      document.removeEventListener('resume', wake);
    };
  }, [session?.user.id, session?.session.id, endpoint, workspaceId, close, accessChanged, revoked]);
  const initialized = useRef(false);
  useEffect(() => {
    if (base && !initialized.current) {
      initialized.current = true;
      setQuery(base.view);
    }
  }, [base]);
  useEffect(() => {
    if (!base || checking || revoked || closed) return;
    let active = true;
    const captured = epoch.current;
    setBusy(true);
    const task = rowId
      ? databaseRequest<Row>(`${endpoint}/rows/${rowId}`).then((r) => {
          if (active && captured === epoch.current) setRow(r);
        })
      : databaseRequest<Table>(`${endpoint}/query`, 'POST', {
          ...query,
          pageSize,
          ...(history.at(-1) ? { cursor: history.at(-1) } : {}),
        }).then((t) => {
          if (active && captured === epoch.current) setTable(t);
        });
    void task
      .catch((e) => {
        if (!active || captured !== epoch.current) return;
        setError(e.message);
        if (e instanceof ContentError && [401, 403, 404].includes(e.status))
          accessChanged(actions.current?.export() ?? '');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [
    endpoint,
    rowId,
    base?.schema_version,
    checking,
    revoked,
    closed,
    query,
    history,
    pageSize,
    reload,
    accessChanged,
  ]);
  async function createRow() {
    if (!base) return;
    setBusy(true);
    setError('');
    receipt.current ??= crypto.randomUUID();
    try {
      await databaseRequest(`${endpoint}/rows`, 'POST', {
        receipt: receipt.current,
        expectedSchemaVersion: base.schema_version,
        title: newTitle,
      });
      receipt.current = undefined;
      setNewTitle('');
      setHistory([undefined]);
      saved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Création impossible.');
    } finally {
      setBusy(false);
    }
  }
  async function lifecycle(r: Row, restore: boolean) {
    setBusy(true);
    try {
      await databaseRequest(`${endpoint}/rows/${r.id}/${restore ? 'restore' : 'archive'}`, 'POST', {
        expectedVersion: String(r.version),
      });
      setTrash(undefined);
      saved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Modification impossible.');
    } finally {
      setBusy(false);
    }
  }
  async function loadTrash(cursor?: string) {
    try {
      const next = await databaseRequest<{ items: Row[]; cursor: string | null }>(
        `${endpoint}/trash${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
      );
      setTrash((old) => ({
        ...next,
        items: cursor ? [...(old?.items ?? []), ...next.items] : next.items,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Corbeille indisponible.');
    }
  }
  async function saveView(q: DatabaseQuery) {
    if (!base) return;
    try {
      await databaseRequest(endpoint, 'PATCH', {
        expectedSchemaVersion: base.schema_version,
        view: q,
      });
      setBase(await databaseRequest<Base>(endpoint));
      setQuery(q);
      setHistory([undefined]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Vue non enregistrée.');
    }
  }
  async function schemaSaved() {
    setBase(await databaseRequest<Base>(endpoint));
    setHistory([undefined]);
    saved();
  }
  if (closed || (!isPending && !session))
    return (
      <main className="p-8">
        <p>Session fermée sur ce poste.</p>
        <a href="/connexion">Se reconnecter</a>
      </main>
    );
  const title = databases.find((b) => b.id === databaseId)?.title || 'Base de données';
  return (
    <main className="database-screen">
      <nav className="mb-4 flex gap-4">
        <a href={`/workspaces/${workspaceId}`}>Retour aux pages</a>
        {rowId && <a href={href}>Retour au tableau</a>}
        <a href="/">Accueil et déconnexion</a>
      </nav>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {revoked ? (
        <section role="alert">
          <p>
            Votre accès à cette base ou à cette ligne a changé. Rechargez pour vérifier vos nouveaux
            accès.
          </p>
          {exported && (
            <button
              onClick={() => {
                const url = URL.createObjectURL(new Blob([exported], { type: 'application/json' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = 'memoria-travail-local.json';
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Exporter le travail resté dans cet onglet
            </button>
          )}
          <button onClick={() => location.reload()}>Recharger</button>
        </section>
      ) : (
        <>
          {checking && (
            <p role="status">Vérification de vos accès. Rétablissez la connexion pour reprendre.</p>
          )}
          <div hidden={checking}>
            <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
            {base?.level === 'read' && (
              <p role="status" className="notice">
                Lecture seule : cette base vous est partagée pour consultation. Demandez un accès en
                édition pour modifier les cellules ou les lignes.
              </p>
            )}
            {rowId && row && session && (
              <PageEditor
                key={row.id}
                actions={actions}
                document={{
                  page: { id: row.id, workspaceId, title: row.title, version: Number(row.version) },
                }}
                endpoint={`${endpoint}/rows/${row.id}`}
                rowDatabaseId={databaseId}
                userId={session.user.id}
                userName={session.user.name}
                sessionId={session.session.id}
                onSaved={saved}
                onDirty={noDirty}
                onLocalRevoked={close}
                onAccessChanged={accessChanged}
                reload={() => location.reload()}
              />
            )}
            {!rowId && base && (
              <>
                <div className="my-4 flex flex-wrap gap-4">
                  <button onClick={() => setFilters((v) => !v)}>Tri et filtres</button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setError('');
                      saved();
                    }}
                  >
                    Actualiser le tableau
                  </button>
                  <button
                    onClick={() => {
                      setHistory([undefined]);
                      setError('');
                      saved();
                    }}
                  >
                    Première page
                  </button>
                  {base.canManageSchema && (
                    <button onClick={() => setSchema((v) => !v)}>Gérer les colonnes</button>
                  )}
                  {base.canManageSchema && (
                    <button onClick={() => void loadTrash()}>Corbeille des lignes</button>
                  )}
                </div>
                {base.viewUnavailable && (
                  <p className="notice">
                    La vue commune contient des filtres devenus indisponibles. L’affichage est
                    réinitialisé.
                  </p>
                )}
                {schema && base.canManageSchema && (
                  <DatabaseSchema
                    base={base}
                    endpoint={endpoint}
                    databases={databases}
                    saved={() => void schemaSaved().catch((e) => setError(e.message))}
                    managePeople={['owner', 'admin'].includes(role)}
                  />
                )}
                {filters && (
                  <DatabaseQueryPanel
                    key={base.schema_version}
                    properties={base.properties}
                    endpoint={endpoint}
                    initial={query}
                    apply={(q) => {
                      setQuery(q);
                      setHistory([undefined]);
                      setFilters(false);
                    }}
                    canSave={base.canManageSchema}
                    save={(q) => void saveView(q)}
                  />
                )}
                <details className="my-3">
                  <summary>Colonnes visibles dans mon affichage</summary>
                  {base.properties.map((p) => (
                    <label className="mr-4 inline-block" key={p.id}>
                      <input
                        type="checkbox"
                        checked={!hidden.includes(p.id)}
                        onChange={(e) =>
                          setHidden((old) =>
                            e.target.checked ? old.filter((id) => id !== p.id) : [...old, p.id],
                          )
                        }
                      />{' '}
                      {p.name}
                    </label>
                  ))}
                </details>
                {base.level === 'edit' && (
                  <form
                    className="my-4 flex gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void createRow();
                    }}
                  >
                    <label>
                      Titre de la nouvelle ligne
                      <input
                        className="field"
                        value={newTitle}
                        maxLength={500}
                        onChange={(e) => {
                          setNewTitle(e.target.value);
                          receipt.current = undefined;
                        }}
                      />
                    </label>
                    <button className="primary" disabled={busy}>
                      Créer une ligne
                    </button>
                  </form>
                )}
                <p className="my-2 text-sm">
                  Les cellules sont enregistrées à la confirmation. Le contenu d’une ligne se
                  modifie dans sa page collaborative.
                </p>
                {table && (
                  <div className="overflow-x-auto">
                    <table className="database-table">
                      <caption className="sr-only">Lignes de la base</caption>
                      <thead>
                        <tr>
                          <th>Titre</th>
                          {base.properties
                            .filter((p) => !hidden.includes(p.id))
                            .map((p) => (
                              <th key={p.id}>{p.name}</th>
                            ))}
                          {base.canManageSchema && <th>Actions</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {table.rows.map((r) => (
                          <tr key={r.id} data-row-id={r.id}>
                            <th scope="row">
                              <a className="quiet-link" href={`${href}/rows/${r.id}`}>
                                {r.title || 'Sans titre'}
                              </a>
                            </th>
                            {base.properties
                              .filter((p) => !hidden.includes(p.id))
                              .map((p) => (
                                <td key={p.id}>
                                  {base.level === 'read' ? (
                                    <span>
                                      {displayValue(tableValue(table, r.id, p), p, base.options)}
                                    </span>
                                  ) : (
                                    <button
                                      aria-label={`Modifier ${p.name} de ${r.title || 'Sans titre'}`}
                                      onClick={() => setCell({ row: r.id, property: p })}
                                    >
                                      {displayValue(tableValue(table, r.id, p), p, base.options)}
                                    </button>
                                  )}
                                </td>
                              ))}
                            {base.canManageSchema && (
                              <td>
                                <button
                                  disabled={busy}
                                  onClick={() => {
                                    if (confirm('Archiver cette ligne ?')) void lifecycle(r, false);
                                  }}
                                >
                                  Archiver {r.title || 'Sans titre'}
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!table.rows.length && <p>Aucune ligne ne correspond à cet affichage.</p>}
                  </div>
                )}
                <div className="my-4 flex gap-4">
                  <label>
                    Lignes par page
                    <select
                      value={pageSize}
                      onChange={(e) => {
                        setPageSize(Number(e.target.value));
                        setHistory([undefined]);
                      }}
                    >
                      <option>10</option>
                      <option>50</option>
                      <option>100</option>
                    </select>
                  </label>
                  <button
                    disabled={busy || history.length <= 1}
                    onClick={() => setHistory((old) => old.slice(0, -1))}
                  >
                    Page précédente
                  </button>
                  <span>Page {history.length}</span>
                  <button
                    disabled={busy || !table?.cursor}
                    onClick={() => setHistory((old) => [...old, table!.cursor!])}
                  >
                    Page suivante
                  </button>
                </div>
                {trash && (
                  <section aria-label="Corbeille des lignes">
                    <h2>Corbeille des lignes</h2>
                    {trash.items.map((r) => (
                      <p key={r.id}>
                        {r.title || 'Sans titre'}{' '}
                        <button disabled={busy} onClick={() => void lifecycle(r, true)}>
                          Restaurer {r.title || 'Sans titre'}
                        </button>
                      </p>
                    ))}
                    {trash.cursor && (
                      <button onClick={() => void loadTrash(trash.cursor!)}>
                        Plus de lignes archivées
                      </button>
                    )}
                    <button onClick={() => setTrash(undefined)}>Fermer la corbeille</button>
                  </section>
                )}
                {cell && base.level === 'edit' && (
                  <DatabaseCell
                    key={`${cell.row}:${cell.property.id}`}
                    endpoint={endpoint}
                    {...cell}
                    options={base.options}
                    close={() => setCell(undefined)}
                    saved={saved}
                  />
                )}
              </>
            )}
          </div>
        </>
      )}
    </main>
  );
}
