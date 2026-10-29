'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { FileBlockContext } from '@memoria/blocks-ui';
import type { FileBlockProps } from '@memoria/blocks-ui';
import { authClient } from '../lib/auth-client.ts';
import { onLocalSignOut } from '../lib/local-sign-out.ts';
import { logoutMarker, yjsCache } from '../lib/yjs-cache.ts';
import { cachePolicyEvent } from '../lib/cache-policy.ts';
import {
  FileLifetime,
  fileRequest,
  riskyDownload,
  uploadFile,
  readPreview,
} from '../lib/file-transfer.ts';
import type { FileMetadata, UploadStatus, UploadProgress } from '../lib/file-transfer.ts';

type Scope = {
  workspace: string;
  page: string;
  editable: boolean;
  endpoint: string;
  life: FileLifetime;
  register: (id: string) => () => void;
  refresh: () => void;
  items: Record<string, FileMetadata>;
  urls: Record<string, string>;
  generation: number;
  disabled: boolean;
};
const Context = createContext<Scope | null>(null);
function useFiles() {
  const scope = useContext(Context);
  if (!scope) throw Error('FILE_SCOPE_REQUIRED');
  return scope;
}
/** Metadata, tickets and revocable preview URLs stay in memory; no persistent file cache. */
export function FileScope({
  workspace,
  page,
  editable,
  children,
}: {
  workspace: string;
  page: string;
  editable: boolean;
  children: ReactNode;
}) {
  const { data: session } = authClient.useSession();
  const user = session?.user.id;
  const [items, setItems] = useState<Record<string, FileMetadata>>({}),
    [urls, setUrls] = useState<Record<string, string>>({}),
    [generation, setGeneration] = useState(0),
    [disabled, setDisabled] = useState(false);
  const life = useMemo(() => {
    const marker = user ? logoutMarker(user) : '';
    return new FileLifetime(() => !user || logoutMarker(user) === marker);
  }, [workspace, page, user]);
  const ids = useRef(new Map<string, number>()),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    running = useRef(false),
    again = useRef(false);
  const previews = useRef<Record<string, { url: string; version: number }>>({});
  const endpoint = `/api/internal/workspaces/${workspace}/files`;
  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () =>
        void (async () => {
          if (running.current) {
            again.current = true;
            return;
          }
          if (!user || globalThis.document.visibilityState === 'hidden' || !navigator.onLine)
            return;
          running.current = true;
          const captured = life.capture();
          try {
            captured.check();
            const files = [...ids.current.keys()];
            const result = files.length
              ? await fileRequest<{ items: FileMetadata[] }>(
                  endpoint + '/resolve',
                  'POST',
                  { pageId: page, files },
                  captured.signal,
                )
              : { items: [] };
            captured.check();
            const next = Object.fromEntries(result.items.map((f) => [f.id, f]));
            const wanted = result.items.filter(
              (f) => f.preview === 'available' && previews.current[f.id]?.version !== f.version,
            );
            if (wanted.length) {
              const tickets = await fileRequest<{ items: { id: string; url: string }[] }>(
                endpoint + '/read-tickets',
                'POST',
                { pageId: page, files: wanted.map((f) => ({ id: f.id, variant: 'display' })) },
                captured.signal,
              );
              captured.check();
              setItems(next);
              for (const t of tickets.items) {
                const blob = await readPreview(t.url, captured.signal);
                captured.check();
                if (!ids.current.has(t.id)) continue;
                const previous = previews.current[t.id];
                if (previous) URL.revokeObjectURL(previous.url);
                previews.current[t.id] = {
                  url: URL.createObjectURL(blob),
                  version: next[t.id]!.version,
                };
              }
            }
            for (const id of Object.keys(previews.current))
              if (!ids.current.has(id) || !next[id] || next[id]!.preview !== 'available') {
                URL.revokeObjectURL(previews.current[id]!.url);
                delete previews.current[id];
              }
            for (const id of Object.keys(next)) if (!ids.current.has(id)) delete next[id];
            setItems(next);
            setUrls(
              Object.fromEntries(Object.entries(previews.current).map(([id, p]) => [id, p.url])),
            );
          } catch {
            if (!captured.signal.aborted) {
              for (const p of Object.values(previews.current)) URL.revokeObjectURL(p.url);
              previews.current = {};
              setItems({});
              setUrls({});
            }
          } finally {
            running.current = false;
            if (again.current) {
              again.current = false;
              refresh();
            }
          }
        })(),
      40,
    );
  }, [endpoint, life, page, user]);
  const register = useCallback(
    (id: string) => {
      ids.current.set(id, (ids.current.get(id) ?? 0) + 1);
      refresh();
      return () => {
        const n = (ids.current.get(id) ?? 1) - 1;
        if (n) ids.current.set(id, n);
        else {
          ids.current.delete(id);
          const preview = previews.current[id];
          if (preview) URL.revokeObjectURL(preview.url);
          delete previews.current[id];
        }
        refresh();
      };
    },
    [refresh],
  );
  useEffect(() => {
    if (!user) return;
    const marker = logoutMarker(user);
    let disposed = false,
      stamp: string | undefined;
    const clear = () => {
      life.reset();
      for (const p of Object.values(previews.current)) URL.revokeObjectURL(p.url);
      previews.current = {};
      setItems({});
      setUrls({});
      setGeneration((n) => n + 1);
    };
    const logout = () => {
      life.close();
      clear();
      setDisabled(true);
    };
    const stop = onLocalSignOut(user, logout);
    const wake = () => {
      clear();
      if (marker !== logoutMarker(user)) logout();
      else refresh();
    };
    const policy = () =>
      void yjsCache
        .accessStamp(user, workspace, page)
        .then((next) => {
          if (disposed) return;
          if (stamp !== undefined && stamp !== next) wake();
          stamp = next;
        })
        .catch(wake);
    policy();
    globalThis.addEventListener('pageshow', wake);
    globalThis.addEventListener('online', wake);
    globalThis.addEventListener('offline', clear);
    globalThis.document.addEventListener('visibilitychange', wake);
    globalThis.document.addEventListener('freeze', clear);
    globalThis.document.addEventListener('resume', wake);
    globalThis.addEventListener(cachePolicyEvent, policy);
    const channel = new BroadcastChannel(cachePolicyEvent);
    channel.onmessage = policy;
    const poll = setInterval(() => {
      if (marker !== logoutMarker(user)) logout();
      else refresh();
    }, 4000);
    return () => {
      disposed = true;
      stop();
      clearTimeout(timer.current);
      clearInterval(poll);
      channel.close();
      life.reset();
      for (const p of Object.values(previews.current)) URL.revokeObjectURL(p.url);
      previews.current = {};
      globalThis.removeEventListener('pageshow', wake);
      globalThis.removeEventListener('online', wake);
      globalThis.removeEventListener('offline', clear);
      globalThis.document.removeEventListener('visibilitychange', wake);
      globalThis.document.removeEventListener('freeze', clear);
      globalThis.document.removeEventListener('resume', wake);
      globalThis.removeEventListener(cachePolicyEvent, policy);
    };
  }, [life, page, refresh, user, workspace]);
  const scope = {
    workspace,
    page,
    editable: editable && !disabled,
    endpoint,
    life,
    register,
    refresh,
    items,
    urls,
    generation,
    disabled,
  };
  return (
    <Context.Provider value={scope}>
      <FileBlockContext.Provider value={EditorFile}>{children}</FileBlockContext.Provider>
    </Context.Provider>
  );
}
export function FileCard({
  id,
  image = false,
  alt = '',
  width = 512,
}: {
  id: string;
  image?: boolean;
  alt?: string;
  width?: number;
}) {
  const scope = useFiles(),
    [warning, setWarning] = useState(false),
    [error, setError] = useState('');
  useEffect(() => scope.register(id), [scope.register, id]);
  useEffect(() => {
    setWarning(false);
    setError('');
  }, [scope.generation]);
  const file = scope.items[id];
  async function download(confirmed = false) {
    const captured = scope.life.capture();
    try {
      captured.check();
      const fresh = await fileRequest<{ items: FileMetadata[] }>(
        scope.endpoint + '/resolve',
        'POST',
        { pageId: scope.page, files: [id] },
        captured.signal,
      );
      captured.check();
      const current = fresh.items[0];
      if (!current) throw Error('Ce fichier n’est plus accessible.');
      if (riskyDownload(current.name, current.mime) && !confirmed) {
        setWarning(true);
        return;
      }
      const tickets = await fileRequest<{ items: { url: string }[] }>(
        scope.endpoint + '/read-tickets',
        'POST',
        { pageId: scope.page, files: [{ id, variant: 'original' }] },
        captured.signal,
      );
      captured.check();
      const url = tickets.items[0]?.url;
      if (!url) throw Error('Ce fichier n’est plus accessible.');
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noreferrer noopener';
      a.referrerPolicy = 'no-referrer';
      a.download = current.name;
      document.body.append(a);
      a.click();
      a.remove();
      setWarning(false);
    } catch (e) {
      if (!captured.signal.aborted)
        setError(e instanceof Error ? e.message : 'Téléchargement indisponible.');
    }
  }
  return (
    <div className="rounded border p-2" data-file-id={id}>
      {!file ? (
        <p>Fichier indisponible ou vérification en cours.</p>
      ) : (
        <>
          <p>
            {file.name} · {(file.bytes / 1024 ** 2).toFixed(1)} Mio
          </p>
          {scope.urls[id] && (
            <img
              src={scope.urls[id]}
              crossOrigin="anonymous"
              alt={alt || file.name}
              style={{ maxWidth: '100%', width: image ? width : 256 }}
              referrerPolicy="no-referrer"
            />
          )}
          {file.preview === 'pending' && (
            <p role="status">Aperçu en préparation. Le fichier est enregistré.</p>
          )}
          {file.preview !== 'available' && file.preview !== 'pending' && (
            <p>Ce format se consulte après téléchargement.</p>
          )}
          <button type="button" className="quiet-link" onClick={() => void download()}>
            Télécharger {file.name}
          </button>
          {warning && (
            <div role="alertdialog" aria-label="Confirmer le téléchargement" className="notice">
              <p>
                Ce fichier peut contenir un programme ou des instructions dangereuses. Ne l’ouvrez
                que si vous connaissez sa provenance.
              </p>
              <button type="button" onClick={() => void download(true)}>
                Télécharger quand même
              </button>{' '}
              <button type="button" onClick={() => setWarning(false)}>
                Annuler le téléchargement
              </button>
            </div>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export function FileUpload({
  onReady,
  onBusy,
}: {
  onReady: (id: string, name: string) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const scope = useFiles(),
    endpoint = `/api/internal/workspaces/${scope.workspace}/file-uploads`;
  const [pending, setPending] = useState<{ id: string; name: string; state: string }[]>([]),
    [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<UploadProgress>(),
    [message, setMessage] = useState('');
  const [source, setSource] = useState(''),
    [choices, setChoices] = useState<FileMetadata[]>([]);
  const [pages, setPages] = useState<{ id: string; title: string }[]>([]),
    [pageChoice, setPageChoice] = useState(''),
    [filter, setFilter] = useState('');
  const controller = useRef<AbortController | null>(null),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    controller.current?.abort();
    setPending([]);
    setChoices([]);
    setSource('');
    setPages([]);
    setPageChoice('');
    setFilter('');
    setSelected('');
    setBusy(false);
    setProgress(undefined);
    setMessage('');
  }, [scope.generation]);
  async function chooseSource() {
    const c = scope.life.capture();
    try {
      const url = new URL(source, location.origin),
        pageId = pageChoice || url.pathname.split('/').filter(Boolean).at(-1);
      if (
        !pageChoice &&
        (url.origin !== location.origin ||
          !url.pathname.includes('/workspaces/' + scope.workspace + '/') ||
          !pageId)
      )
        throw Error('Collez le lien d’une page ou d’une ligne de cet espace.');
      const r = await fileRequest<{ items: FileMetadata[] }>(
        scope.endpoint + '/select',
        'POST',
        { pageId },
        c.signal,
      );
      c.check();
      setChoices(r.items);
      if (!r.items.length) setMessage('Aucun fichier accessible sur cette page.');
    } catch (e) {
      if (!c.signal.aborted) setMessage(e instanceof Error ? e.message : 'Source inaccessible.');
    }
  }
  async function listPages() {
    const c = scope.life.capture();
    try {
      const result = await fileRequest<{ pages: { id: string; title: string }[] }>(
        `/api/internal/workspaces/${scope.workspace}/pages`,
        'GET',
        undefined,
        c.signal,
      );
      c.check();
      setPages(result.pages);
    } catch (e) {
      if (!c.signal.aborted) setMessage(e instanceof Error ? e.message : 'Pages indisponibles.');
    }
  }
  async function list() {
    const c = scope.life.capture();
    try {
      const r = await fileRequest<{ items: typeof pending }>(
        endpoint + '/pending',
        'POST',
        { pageId: scope.page },
        c.signal,
      );
      c.check();
      setPending(r.items);
    } catch (e) {
      if (!c.signal.aborted) setMessage(e instanceof Error ? e.message : 'Reprise indisponible.');
    }
  }
  async function ready(id: string) {
    const c = scope.life.capture();
    setBusy(true);
    onBusy?.(true);
    try {
      const s = await fileRequest<UploadStatus>(endpoint + '/' + id, 'GET', undefined, c.signal);
      c.check();
      if (s.state === 'ready') {
        onReady(s.id, s.name);
        setSelected('');
        setPending((old) => old.filter((p) => p.id !== id));
        setMessage('Fichier prêt. Confirmez la cellule, ou attendez l’enregistrement de la page.');
      } else if (['rejected', 'deleted', 'deleting'].includes(s.state))
        setMessage('Ce fichier a été refusé ou supprimé. Choisissez un autre fichier.');
      else
        setMessage(
          'Aperçu en préparation : le serveur vérifie le fichier. Vous pouvez revenir plus tard et consulter son état.',
        );
    } catch (e) {
      if (!c.signal.aborted)
        setMessage(e instanceof Error ? e.message : 'Vérification indisponible.');
    } finally {
      if (active.current) {
        setBusy(false);
        onBusy?.(false);
      }
    }
  }
  async function send(file: File) {
    const c = scope.life.capture(),
      local = new AbortController();
    controller.current = local;
    const signal = AbortSignal.any([c.signal, local.signal]);
    setBusy(true);
    onBusy?.(true);
    setMessage('');
    try {
      const s = await uploadFile(
        endpoint,
        scope.page,
        file,
        signal,
        (p) => {
          if (active.current && !signal.aborted) setProgress(p);
        },
        selected || undefined,
      );
      c.check();
      signal.throwIfAborted();
      setSelected(s.id);
      setPending((old) => [
        ...old.filter((p) => p.id !== s.id),
        { id: s.id, name: s.name, state: s.state },
      ]);
      if (s.state === 'ready') {
        onReady(s.id, s.name);
        setSelected('');
      } else setMessage('Envoi terminé. Aperçu en préparation : le serveur vérifie le fichier.');
    } catch (e) {
      if (active.current && !c.signal.aborted)
        setMessage(
          local.signal.aborted
            ? 'Envoi en pause. Retrouvez-le dans « Reprendre un envoi », puis choisissez le même fichier.'
            : e instanceof Error
              ? e.message
              : 'Envoi interrompu. Reprenez avec le même fichier.',
        );
    } finally {
      if (active.current) {
        setBusy(false);
        onBusy?.(false);
        setProgress(undefined);
      }
    }
  }
  return (
    <section aria-label="Joindre un fichier" className="my-2 rounded border p-3">
      <p>
        Le fichier sera accessible aux personnes qui peuvent lire cette page. Il reste sur votre
        disque jusqu’à l’envoi.
      </p>
      <button type="button" disabled={busy || !scope.editable} onClick={() => void list()}>
        Reprendre un envoi
      </button>
      {!!pending.length && (
        <label>
          Envoi à reprendre
          <select
            aria-label="Envoi à reprendre"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy}
          >
            <option value="">Nouvel envoi</option>
            {pending.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {selected ? 'Choisir le même fichier' : 'Choisir un fichier'}
        <input
          aria-label="Fichier à envoyer"
          type="file"
          disabled={busy || !scope.editable}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void send(file);
          }}
        />
      </label>
      {busy && (
        <button type="button" onClick={() => controller.current?.abort()}>
          Mettre en pause
        </button>
      )}
      {progress && (
        <p role="status">
          {progress.phase === 'hashing'
            ? 'Préparation du fichier'
            : progress.phase === 'sending'
              ? 'Envoi'
              : 'Vérification sur le serveur'}{' '}
          · {Math.round((progress.done / Math.max(1, progress.total)) * 100)} %
        </p>
      )}
      {selected && !busy && (
        <button type="button" onClick={() => void ready(selected)}>
          Vérifier et joindre le fichier
        </button>
      )}
      {message && <p role="status">{message}</p>}
      <details>
        <summary>Réutiliser un fichier d’une page</summary>
        <button type="button" disabled={busy || !scope.editable} onClick={() => void listPages()}>
          Choisir une page accessible
        </button>
        <label>
          Page source
          <select
            value={pageChoice}
            onChange={(e) => {
              setPageChoice(e.target.value);
              setChoices([]);
            }}
          >
            <option value="">Utiliser un lien de ligne ci-dessous</option>
            <option value={scope.page}>Cette page</option>
            {pages
              .filter((p) => p.id !== scope.page)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title || 'Sans titre'}
                </option>
              ))}
          </select>
        </label>
        <label>
          Lien de la page source
          <input
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setPageChoice('');
            }}
          />
        </label>
        <button
          type="button"
          disabled={busy || !scope.editable}
          onClick={() => void chooseSource()}
        >
          Afficher les fichiers accessibles
        </button>
        <p>
          Réutiliser un fichier donne un accès indépendant aux lecteurs de cette page, même si le
          partage de la source est retiré ensuite.
        </p>
        {!!choices.length && (
          <label>
            Filtrer les fichiers
            <input value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
        )}
        {choices
          .filter((f) => f.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
          .map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                scope.life.capture().check();
                onReady(f.id, f.name);
                setChoices([]);
              }}
            >
              Réutiliser {f.name}
            </button>
          ))}
      </details>
      <p className="text-sm">
        Après fermeture, utilisez « Reprendre un envoi ». Aucun fichier ni lien de téléchargement
        n’est conservé dans le cache de ce navigateur.
      </p>
    </section>
  );
}
function EditorFile(props: FileBlockProps) {
  const scope = useFiles();
  return (
    <div>
      {props.fileId && (
        <FileCard
          id={props.fileId}
          image={props.image}
          {...(props.alt === undefined ? {} : { alt: props.alt })}
          {...(props.width === undefined ? {} : { width: props.width })}
        />
      )}
      {props.editable && scope.editable ? (
        <>
          {!props.fileId && <FileUpload onReady={(id) => props.onChange(id)} />}
          {props.fileId && (
            <button type="button" onClick={() => props.onChange('')}>
              Retirer de cette page
            </button>
          )}
        </>
      ) : (
        <p>Lecture seule : vous pouvez consulter les fichiers, sans en ajouter ni en retirer.</p>
      )}
    </div>
  );
}
