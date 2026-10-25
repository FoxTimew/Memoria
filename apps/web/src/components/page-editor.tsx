'use client';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { BlockNoteEditor, insertOrUpdateBlockForSlashMenu } from '@blocknote/core';
import { withCollaboration } from '@blocknote/core/yjs';
import { fr } from '@blocknote/core/locales';
import { BlockNoteView } from '@blocknote/mantine';
import { SuggestionMenuController } from '@blocknote/react';
import { createEditorKit } from '@memoria/block-catalog/client';
import { collaborationAccessSchema, presenceUser } from '@memoria/contracts';
import type { PageDocument } from '@memoria/contracts';
import { contentRequest } from '../lib/content-api.ts';
import { CollaborationClient } from '../lib/collaboration-client.ts';
import type { CollaborationStatus } from '../lib/collaboration-client.ts';
import { PageTitle } from './page-title.tsx';
import { LocalRecovery } from './local-recovery.tsx';
import { AccessChanged, CacheForbidden, LocalSessionRevoked, yjsCache } from '../lib/yjs-cache.ts';
import { refreshCachePolicy } from '../lib/cache-policy.ts';
import type { CachePage, CacheTicket } from '../lib/yjs-cache.ts';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';

type Kit = Awaited<ReturnType<typeof createEditorKit>>;
type Editor = Kit['schema']['BlockNoteEditor'];
export type EditorActions = { discard: () => Promise<unknown>; export: () => string };
export default function PageEditor({
  actions,
  document,
  endpoint,
  onSaved,
  onDirty,
  onLocalRevoked,
  onAccessChanged,
  reload,
  userId,
  userName,
  sessionId,
}: {
  actions: RefObject<EditorActions | null>;
  document: PageDocument;
  endpoint: string;
  onSaved: () => void;
  onDirty: (dirty: boolean) => void;
  onLocalRevoked: (message?: string) => void;
  onAccessChanged: (exported: string, cleanupError?: string) => void;
  reload: () => void;
  userId: string;
  userName: string;
  sessionId: string;
}) {
  const [loaded, setLoaded] = useState<{ kit: Kit; editor: Editor; client: CollaborationClient }>();
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<CollaborationStatus>();
  const [recovery, setRecovery] = useState<{ ticket: CacheTicket; pages: CachePage[] }>();
  useEffect(() => {
    let cancelled = false,
      editor: Editor | undefined,
      client: CollaborationClient | undefined;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        let ticket: CacheTicket | undefined;
        try {
          ticket = await refreshCachePolicy(userId, sessionId);
        } catch (e) {
          if (!(e instanceof CacheForbidden)) throw e;
        }
        const [kit, opened] = await Promise.all([
          createEditorKit(),
          contentRequest(`${endpoint}/collaboration`, 'POST'),
        ]);
        const meta = collaborationAccessSchema.parse(opened);
        if (meta.identity.user !== userId || meta.identity.session !== sessionId)
          throw new LocalSessionRevoked();
        if (ticket && ticket.accessVersions[document.page.workspaceId] !== meta.accessVersion)
          throw new AccessChanged();
        let cached: Awaited<ReturnType<typeof yjsCache.open>> | undefined;
        if (ticket && ticket.policies[document.page.workspaceId] !== undefined)
          try {
            cached = await yjsCache.open(
              ticket,
              document.page.workspaceId,
              document.page.id,
              meta.generation,
            );
          } catch (e) {
            if (!(e instanceof CacheForbidden)) throw e;
          }
        if (cancelled) return;
        if (ticket && cached) setRecovery({ ticket, pages: cached.older });
        const url = new URL('/collab', location.origin);
        url.protocol = 'wss:';
        client = new CollaborationClient(
          meta.room,
          meta.generation,
          { url: url.href },
          async () => {
            try {
              await refreshCachePolicy(userId, sessionId);
            } catch (e) {
              if (!(e instanceof CacheForbidden)) throw e;
            }
            const fresh = collaborationAccessSchema.parse(
              await contentRequest(`${endpoint}/collaboration`, 'POST'),
            );
            if (fresh.identity.user !== userId || fresh.identity.session !== sessionId)
              throw new LocalSessionRevoked();
            if (fresh.accessVersion !== meta.accessVersion || fresh.level !== meta.level)
              throw new AccessChanged();
          },
          presenceUser(userId, userName),
          sessionId,
          meta.accessVersion,
          meta.level === 'read',
        );
        const accessChanged = () => {
          if (cancelled) return;
          const exported =
            actions.current?.export() ??
            JSON.stringify({
              pageId: document.page.id,
              title: document.page.title,
              blocks: editor?.document ?? [],
            });
          if (ticket)
            void yjsCache
              .revokeWorkspace(ticket, document.page.workspaceId)
              .catch(() =>
                onAccessChanged(
                  '',
                  'Impossible d’effacer la copie locale. Déconnectez-vous pour réessayer le nettoyage.',
                ),
              );
          client?.destroy();
          onAccessChanged(exported);
        };
        client.onAccessRevoked = accessChanged;
        if (ticket && cached)
          client.attachCache(ticket, cached.page, cached.updates, (message) => {
            if (message) {
              accessChanged();
              return;
            }
            editor?._tiptapEditor.destroy();
            setLoaded(undefined);
            onLocalRevoked(message);
          });
        const activeClient = client;
        unsubscribe = client.subscribe((state) => {
          if (cancelled) return;
          setConnection(state);
          // Mount only after the server document arrived: never seed from a stale SQL projection.
          if (state.loaded && !editor && state.phase !== 'blocked') {
            try {
              editor = BlockNoteEditor.create(
                withCollaboration({
                  schema: kit.schema,
                  dictionary: fr,
                  collaboration: {
                    fragment: activeClient.doc.getXmlFragment('prosemirror'),
                    provider: { awareness: activeClient.provider.awareness! },
                    user: presenceUser(userId, userName),
                    showCursorLabels: 'always',
                  },
                }),
              );
              editor.isEditable = !activeClient.readOnly;
              setLoaded({ kit, editor, client: activeClient });
            } catch {
              activeClient.stop('EDITOR_SCHEMA');
            }
          }
        });
        client.connect();
      } catch (e) {
        if (!cancelled) {
          if (e instanceof LocalSessionRevoked) onLocalRevoked();
          else setError(e instanceof Error ? e.message : 'Chargement impossible.');
        }
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
      editor?._tiptapEditor.destroy();
      client?.destroy();
    };
  }, [endpoint, userId, sessionId, userName, onLocalRevoked, onAccessChanged]);
  if (error || (!loaded && connection?.phase === 'blocked'))
    return (
      <div role="alert" className="notice error m-6">
        <p>{error || connection?.message}</p>
        <button className="quiet-link" onClick={reload}>
          Réessayer
        </button>
      </div>
    );
  if (!loaded)
    return (
      <p role="status" className="p-6">
        {connection?.phase === 'offline'
          ? 'Connexion au service interrompue. Nouvelle tentative en cours…'
          : 'Chargement du document collaboratif…'}
      </p>
    );
  return (
    <>
      {recovery && <LocalRecovery {...recovery} />}
      <ActiveEditor
        {...loaded}
        actions={actions}
        state={connection!}
        document={document}
        onSaved={onSaved}
        onDirty={onDirty}
        endpoint={endpoint}
        reload={reload}
      />
    </>
  );
}
function ActiveEditor({
  kit,
  editor,
  client,
  actions,
  state,
  document,
  endpoint,
  onSaved,
  onDirty,
  reload,
}: {
  kit: Kit;
  editor: Editor;
  client: CollaborationClient;
  actions: RefObject<EditorActions | null>;
  state: CollaborationStatus;
  document: PageDocument;
  endpoint: string;
  onSaved: () => void;
  onDirty: (dirty: boolean) => void;
  reload: () => void;
}) {
  const [titleDirty, setTitleDirty] = useState(false),
    [discard, setDiscard] = useState(false);
  const [titleValue, setTitleValue] = useState(document.page.title);
  const [link, setLink] = useState(''),
    [linkError, setLinkError] = useState('');
  const dirty = (state.dirty && state.local.phase !== 'saved') || titleDirty,
    blocked = state.phase === 'blocked' || state.phase === 'checking' || client.readOnly;
  const latest = useRef({ dirty, titleValue });
  latest.current = { dirty, titleValue };
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    actions.current = {
      export: () =>
        JSON.stringify(
          {
            pageId: document.page.id,
            generation: client.generation,
            exportedAt: new Date().toISOString(),
            title: latest.current.titleValue,
            blocks: editor.document,
          },
          null,
          2,
        ),
      discard: async () => {
        await client.cache?.discard();
        client.destroy();
      },
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (latest.current.dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    globalThis.addEventListener('beforeunload', leave);
    return () => {
      actions.current = null;
      globalThis.removeEventListener('beforeunload', leave);
    };
  }, [actions, client]);
  useEffect(() => {
    editor.isEditable = !blocked;
  }, [editor, blocked]);
  const download = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            pageId: document.page.id,
            generation: client.generation,
            exportedAt: new Date().toISOString(),
            title: titleValue,
            blocks: editor.document,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob),
      anchor = globalThis.document.createElement('a');
    anchor.href = url;
    anchor.download = `memoria-contenu-${document.page.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const items = kit.adapters.map(({ ui }) => ({
    title: ui.menu.label,
    group: ui.menu.category,
    aliases: [...ui.menu.keywords],
    onItemClick: () => {
      if (blocked) return;
      const block = kit.toEditor([
        {
          id: crypto.randomUUID(),
          parentId: null,
          position: 'a0',
          type: ui.model.type,
          schemaVersion: ui.model.version,
          content: ui.model.createDefault(),
        },
      ])[0]!;
      insertOrUpdateBlockForSlashMenu<
        typeof kit.schema.blockSchema,
        typeof kit.schema.inlineContentSchema,
        typeof kit.schema.styleSchema
      >(editor, block);
    },
  }));
  const statuses = {
    checking: 'Vérification de vos accès…',
    connecting: 'Connexion…',
    saved: 'Enregistré sur le serveur',
    saving: 'Enregistrement sur le serveur…',
    offline:
      state.local.phase === 'none'
        ? 'Hors ligne — gardez cet onglet ouvert'
        : state.local.phase === 'saved'
          ? 'Hors ligne — modifications conservées sur cet appareil'
          : 'Hors ligne — copie locale en attente',
    blocked: 'Édition arrêtée',
  };
  return (
    <div className="page-editor">
      {client.readOnly && (
        <p role="status" className="notice mx-6 mt-4">
          Lecture seule : cette page vous a été partagée pour consultation. Demandez un accès en
          édition à un administrateur pour la modifier.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e3e6dd] px-6 py-3 text-sm">
        <span role="status" aria-live="polite" data-testid="save-status">
          {statuses[state.phase]}
        </span>
        <button className="quiet-link" onClick={download}>
          Exporter le contenu affiché
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-2 text-sm">
        <span role="status" data-testid="local-save-status">
          {state.local.phase === 'none'
            ? 'Copie locale désactivée sur cet appareil ou dans cet espace'
            : state.local.phase === 'saved'
              ? 'Copie locale à jour'
              : state.local.phase === 'error'
                ? 'Copie locale indisponible'
                : 'Copie locale en cours…'}
        </span>
        <ul aria-label="Personnes connectées" className="flex flex-wrap gap-3">
          {state.people.map((person) => (
            <li key={person.id} data-user-id={person.id} style={{ color: person.color }}>
              {person.name}
            </li>
          ))}
        </ul>
      </div>
      {state.local.phase === 'error' && (
        <div role="alert" className="notice error mx-6 mt-4">
          <p>
            {state.local.message} Gardez cet onglet ouvert ou exportez le contenu tant que la copie
            locale ou l’enregistrement serveur ne sont pas confirmés.
          </p>
          <button className="quiet-link" onClick={() => void client.cache?.retry()}>
            Réessayer la copie locale
          </button>
        </div>
      )}
      {state.phase === 'offline' && !client.readOnly && (
        <p className="notice mx-6 mt-4">
          {state.local.phase === 'none'
            ? 'Vous pouvez continuer à écrire, mais fermer ou recharger cet onglet perdra les changements non envoyés. Rétablissez la connexion ou exportez le contenu avant de partir.'
            : 'Vous pouvez continuer à écrire. Attendez « Copie locale à jour » avant de fermer cet onglet. Pour le rouvrir, rétablissez la connexion : vos droits seront vérifiés avant de récupérer les modifications.'}{' '}
          Le titre non enregistré reste uniquement dans cet onglet.
        </p>
      )}
      {state.phase === 'blocked' && (
        <div role="alert" className="notice error mx-6 mt-4">
          <p>{state.message}</p>
          <button className="quiet-link" onClick={() => setDiscard(true)}>
            Charger la version serveur
          </button>
        </div>
      )}
      {discard && (
        <div role="dialog" aria-label="Recharger la page" className="notice mx-6 mt-4">
          <p>
            Exportez d’abord le contenu souhaité. Le rechargement abandonne les modifications non
            enregistrées.
          </p>
          <button className="quiet-link mr-4" onClick={() => setDiscard(false)}>
            Annuler
          </button>
          <button className="primary" onClick={reload}>
            Abandonner et recharger
          </button>
        </div>
      )}
      <div hidden={state.phase === 'checking'}>
        <PageTitle
          title={document.page.title}
          version={document.page.version}
          endpoint={endpoint}
          disabled={blocked}
          onDirty={setTitleDirty}
          onSaved={onSaved}
          onValue={setTitleValue}
        />
        <fieldset disabled={blocked} className="contents">
          <div className="editor-toolbar" role="toolbar" aria-label="Mise en forme">
            {(['bold', 'italic', 'underline', 'strike', 'code'] as const).map((style, i) => (
              <button
                key={style}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.toggleStyles({ [style]: true });
                  editor.focus();
                }}
              >
                {['Gras', 'Italique', 'Souligné', 'Barré', 'Code inline'][i]}
              </button>
            ))}
            {([1, 2, 3] as const).map((level) => (
              <button
                key={level}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() =>
                  editor.updateBlock(editor.getTextCursorPosition().block, {
                    type: 'heading',
                    props: { level },
                  })
                }
              >
                H{level}
              </button>
            ))}
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.moveBlocksUp()}>
              Monter
            </button>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => editor.moveBlocksDown()}>
              Descendre
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (editor.canNestBlock()) editor.nestBlock();
              }}
            >
              Indenter
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (editor.canUnnestBlock()) editor.unnestBlock();
              }}
            >
              Désindenter
            </button>
          </div>
          <form
            className="mx-6 mb-3 flex gap-2 text-sm"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                const url = new URL(link);
                if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
                editor.createLink(url.href);
                editor.focus();
                setLink('');
                setLinkError('');
              } catch {
                setLinkError('Le lien doit commencer par https:// ou http://.');
              }
            }}
          >
            <input
              className="field"
              aria-label="Adresse du lien"
              placeholder="https://… (sur le texte sélectionné)"
              value={link}
              maxLength={2048}
              onChange={(e) => setLink(e.target.value)}
            />
            <button type="submit" className="quiet-link">
              Ajouter le lien
            </button>
          </form>
          {linkError && (
            <p role="alert" className="notice error mx-6 mb-3">
              {linkError}
            </p>
          )}
          <BlockNoteView
            editor={editor}
            editable={!blocked}
            theme="light"
            formattingToolbar={false}
            linkToolbar={false}
            sideMenu={false}
            slashMenu={false}
            filePanel={false}
            tableHandles={false}
          >
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={async (query) =>
                items.filter((item) =>
                  `${item.title} ${item.aliases.join(' ')}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
              }
            />
          </BlockNoteView>
        </fieldset>
      </div>
      <p className="px-6 py-5 text-xs text-[#73806f]">
        Tapez / pour ajouter un bloc. Tab et Maj+Tab règlent l’imbrication. Ctrl+Z annule une
        modification.
      </p>
    </div>
  );
}
