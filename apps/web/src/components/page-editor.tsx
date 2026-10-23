'use client';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { BlockNoteEditor, insertOrUpdateBlockForSlashMenu } from '@blocknote/core';
import { fr } from '@blocknote/core/locales';
import { BlockNoteView } from '@blocknote/mantine';
import { SuggestionMenuController } from '@blocknote/react';
import { createEditorKit } from '@memoria/block-catalog/client';
import type { PageDocument } from '@memoria/contracts';
import { pageVersionSchema, pageSaveResultSchema } from '@memoria/contracts';
import { contentRequest } from '../lib/content-api.ts';
import { PageDraft } from '../lib/page-draft.ts';
import { localDrafts, needsRecovery } from '../lib/local-drafts.ts';
import type { LocalDraft, LocalDraftHandle } from '../lib/local-drafts.ts';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';

type Kit = Awaited<ReturnType<typeof createEditorKit>>;
type Editor = Kit['schema']['BlockNoteEditor'];
export type EditorActions = { discard: () => Promise<unknown> };
export default function PageEditor({
  userId,
  sessionId,
  actions,
  document,
  endpoint,
  onSaved,
  onDirty,
  reload,
}: {
  userId: string;
  sessionId: string;
  actions: RefObject<EditorActions | null>;
  document: PageDocument;
  endpoint: string;
  onSaved: () => void;
  onDirty: (dirty: boolean) => void;
  reload: () => void;
}) {
  const [loaded, setLoaded] = useState<{ kit: Kit; editor: Editor; local?: LocalDraftHandle }>();
  const [recovery, setRecovery] = useState<LocalDraft>();
  const [restored, setRestored] = useState<LocalDraft>();
  const [localError, setLocalError] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let created: Editor | undefined;
    createEditorKit()
      .then(async (kit) => {
        if (cancelled) return;
        const initialContent = kit.toEditor(document.blocks);
        created = BlockNoteEditor.create({
          schema: kit.schema,
          dictionary: fr,
          initialContent: initialContent.length
            ? initialContent
            : [{ id: globalThis.crypto.randomUUID(), type: 'paragraph', content: [] }],
        });
        const editor = created;
        let local: LocalDraftHandle | undefined;
        try {
          local = await localDrafts.open(userId, sessionId, document.page.id);
          const confirmed = {
            title: document.page.title,
            blocks: document.blocks.length ? kit.fromEditor(editor.document) : [],
          };
          if (local.recovered && needsRecovery(local.recovered, confirmed)) {
            if (!cancelled) setRecovery(local.recovered);
          } else if (local.recovered) await local.discard(false);
        } catch {
          if (!cancelled)
            setLocalError(
              'La sauvegarde locale est indisponible. Exportez votre brouillon avant de quitter la page.',
            );
        }
        if (!cancelled) setLoaded({ kit, editor, ...(local ? { local } : {}) });
      })
      .catch(() =>
        setError(
          'Un bloc de cette page est inconnu, invalide ou plus récent. Le contenu original est conservé ; l’édition est désactivée.',
        ),
      );
    return () => {
      cancelled = true;
      created?._tiptapEditor.destroy();
    };
  }, [document, userId, sessionId]);
  if (error)
    return (
      <div className="notice error" role="alert">
        <p>{error}</p>
        <details>
          <summary>Afficher les données préservées</summary>
          <pre className="overflow-auto whitespace-pre-wrap">
            {JSON.stringify(document.blocks, null, 2)}
          </pre>
        </details>
      </div>
    );
  if (!loaded) return <p role="status">Chargement de l’éditeur…</p>;
  if (recovery)
    return (
      <div role="dialog" aria-label="Brouillon local retrouvé" className="notice m-6">
        <strong>Un brouillon non enregistré a été retrouvé sur cet appareil.</strong>
        <p>
          {recovery.snapshot.draft.title || 'Sans titre'} ·{' '}
          {new Date(recovery.updatedAt).toLocaleString('fr-FR')}
        </p>
        <p>
          Restaurez-le pour le relire. Si la version serveur a changé, la sauvegarde restera
          suspendue.
        </p>
        {localError && <p role="alert">{localError}</p>}
        <div className="mt-3 flex gap-4">
          <button
            className="primary"
            disabled={choosing}
            onClick={() => {
              try {
                loaded.editor.replaceBlocks(
                  loaded.editor.document,
                  recovery.editorDocument as Parameters<Editor['replaceBlocks']>[1],
                );
                setRestored(recovery);
                setRecovery(undefined);
              } catch {
                setLocalError(
                  'Ce brouillon ne peut pas être ouvert par cet éditeur. Exportez-le pour conserver ses données.',
                );
              }
            }}
          >
            Restaurer le brouillon
          </button>
          <button
            className="quiet-link"
            disabled={choosing}
            onClick={() => {
              setChoosing(true);
              void loaded.local
                ?.discard(false)
                .then(() => setRecovery(undefined))
                .catch(() => setLocalError('Impossible d’effacer le brouillon local. Réessayez.'))
                .finally(() => setChoosing(false));
            }}
          >
            Abandonner le brouillon local
          </button>
          <button className="quiet-link" onClick={() => downloadDraft(document.page.id, recovery)}>
            Exporter le brouillon
          </button>
        </div>
      </div>
    );
  return (
    <ActiveEditor
      {...loaded}
      actions={actions}
      restored={restored}
      initialLocalError={localError}
      document={document}
      endpoint={endpoint}
      onSaved={onSaved}
      onDirty={onDirty}
      reload={reload}
    />
  );
}
function ActiveEditor({
  local,
  restored,
  initialLocalError,
  actions,
  kit,
  editor,
  document,
  endpoint,
  onSaved,
  onDirty,
  reload,
}: {
  local?: LocalDraftHandle;
  restored: LocalDraft | undefined;
  initialLocalError: string;
  actions: RefObject<EditorActions | null>;
  kit: Kit;
  editor: Editor;
  document: PageDocument;
  endpoint: string;
  onSaved: () => void;
  onDirty: (dirty: boolean) => void;
  reload: () => void;
}) {
  const [, render] = useState(0);
  const [conversionError, setConversionError] = useState(
    restored?.invalid
      ? 'Le brouillon contient des données non prises en charge. Corrigez-les ou exportez-le.'
      : '',
  );
  const invalid = useRef(Boolean(restored?.invalid));
  const [localError, setLocalError] = useState(initialLocalError);
  const active = useRef(true);
  const rawDocument = useRef(editor.document);
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState('');
  const [discard, setDiscard] = useState(false);
  const callbacks = useRef({ onSaved, onDirty });
  callbacks.current = { onSaved, onDirty };
  const [draft] = useState(() => {
    const state = new PageDraft(
      document.page.version,
      restored?.snapshot.base ?? {
        title: document.page.title,
        blocks: document.blocks.length ? kit.fromEditor(editor.document) : [],
      },
      {
        version: async () =>
          pageVersionSchema.parse(await contentRequest(`${endpoint}/version`)).version,
        save: async (version, snapshot, operations) => {
          const saved = pageSaveResultSchema.parse(
            await contentRequest(endpoint, 'PUT', {
              expectedVersion: version,
              title: snapshot.title,
              operations,
            }),
          );
          callbacks.current.onSaved();
          return saved.version;
        },
      },
      () => {
        void local
          ?.sync(state.snapshot(), rawDocument.current, invalid.current)
          .then(() => {
            if (active.current) setLocalError('');
          })
          .catch(() => {
            if (active.current)
              setLocalError(
                'Le brouillon local n’a pas pu être conservé. Gardez cette page ouverte ou exportez-le.',
              );
          });
        if (active.current) render((n) => n + 1);
      },
    );
    // Restore before exposing the editor; persistence resumes in the mount effect.
    if (restored) state.restore(restored.snapshot, document.page.version, false);
    return state;
  });
  useEffect(() => {
    active.current = true;
    actions.current = {
      discard: async () => {
        await local?.discard();
        active.current = false;
      },
    };
    return () => {
      active.current = false;
      actions.current = null;
    };
  }, [actions, local]);
  // Empty persisted documents start with BlockNote's editable paragraph, which is saved on first edit.
  useEffect(
    () =>
      editor.onChange(() => {
        rawDocument.current = editor.document;
        try {
          const blocks = kit.fromEditor(editor.document);
          invalid.current = false;
          setConversionError('');
          draft.change({ title: draft.draft.title, blocks });
        } catch {
          invalid.current = true;
          setConversionError(
            'Ce contenu ne peut pas être sauvegardé. Retirez les styles ou liens non pris en charge, ou réduisez la page à 500 blocs.',
          );
          callbacks.current.onDirty(true);
          // Preserve even raw editor data which cannot pass the server model validators.
          draft.change(draft.draft);
        }
      }),
    [draft, editor, kit],
  );
  useEffect(() => {
    callbacks.current.onDirty(draft.dirty || Boolean(conversionError));
    if (draft.status !== 'dirty' || conversionError) return;
    const timer = globalThis.setTimeout(() => {
      void draft.flush();
    }, 900);
    return () => globalThis.clearTimeout(timer);
  }, [draft, draft.status, draft.draft, conversionError]);
  useEffect(() => {
    const check = () => {
      if (globalThis.document.visibilityState === 'visible') void draft.poll();
    };
    const interval = globalThis.setInterval(check, 15000);
    globalThis.addEventListener('focus', check);
    globalThis.document.addEventListener('visibilitychange', check);
    const leave = (event: BeforeUnloadEvent) => {
      if (draft.dirty || conversionError) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    globalThis.addEventListener('beforeunload', leave);
    return () => {
      globalThis.clearInterval(interval);
      globalThis.removeEventListener('focus', check);
      globalThis.document.removeEventListener('visibilitychange', check);
      globalThis.removeEventListener('beforeunload', leave);
    };
  }, [draft, conversionError]);
  const download = () =>
    downloadDraft(document.page.id, {
      snapshot: draft.snapshot(),
      editorDocument: editor.document,
    });
  const items = kit.adapters.map(({ ui }) => ({
    title: ui.menu.label,
    group: ui.menu.category,
    aliases: [...ui.menu.keywords],
    onItemClick: () => {
      const block = kit.toEditor([
        {
          id: globalThis.crypto.randomUUID(),
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
    clean: 'Enregistré',
    dirty: 'Modifications en attente…',
    saving: 'Enregistrement…',
    conflict: 'Version modifiée ailleurs',
    error: 'Enregistrement interrompu',
  };
  return (
    <div className="page-editor">
      {localError && (
        <p role="alert" className="notice error mx-6 mt-4">
          {localError}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e3e6dd] px-6 py-3 text-sm">
        <span role="status" aria-live="polite">
          {statuses[draft.status]} · v{draft.version}
        </span>
        <div className="flex gap-3">
          <button className="quiet-link" onClick={download}>
            Exporter le brouillon
          </button>
          <button
            className="quiet-link"
            disabled={
              Boolean(conversionError) ||
              !draft.dirty ||
              ['saving', 'conflict'].includes(draft.status)
            }
            onClick={() => void draft.flush()}
          >
            Enregistrer
          </button>
        </div>
      </div>
      {draft.status === 'conflict' && (
        <div role="alert" className="notice mx-6 mt-4">
          <strong>Cette page a changé dans une autre session.</strong>
          <p>
            La sauvegarde est suspendue et votre brouillon reste ici. Exportez-le avant de charger
            la version serveur.
          </p>
          <button className="quiet-link" onClick={() => setDiscard(true)}>
            Charger la version serveur
          </button>
        </div>
      )}
      {draft.status === 'error' && (
        <p role="alert" className="notice error mx-6 mt-4">
          {draft.error}{' '}
          <button className="quiet-link" onClick={() => void draft.flush()}>
            Réessayer
          </button>
        </p>
      )}
      {conversionError && (
        <p role="alert" className="notice error mx-6 mt-4">
          {conversionError}
        </p>
      )}
      {discard && (
        <div role="dialog" aria-label="Recharger la page" className="notice mx-6 mt-4">
          <p>Le rechargement abandonne le brouillon affiché.</p>
          <button className="quiet-link mr-5" onClick={() => setDiscard(false)}>
            Conserver le brouillon
          </button>
          <button
            className="primary"
            onClick={() => {
              callbacks.current.onDirty(false);
              reload();
            }}
          >
            Abandonner et recharger
          </button>
        </div>
      )}
      <input
        aria-label="Titre de la page"
        className="page-title"
        maxLength={500}
        placeholder="Sans titre"
        value={draft.draft.title}
        onChange={(event) => draft.change({ ...draft.draft, title: event.target.value })}
      />
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
              `${item.title} ${item.aliases.join(' ')}`.toLowerCase().includes(query.toLowerCase()),
            )
          }
        />
      </BlockNoteView>
      <p className="px-6 py-5 text-xs text-[#73806f]">
        Tapez / pour ajouter un bloc. Tab et Maj+Tab règlent l’imbrication. Ctrl+Z annule une
        modification.
      </p>
    </div>
  );
}
function downloadDraft(pageId: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement('a');
  anchor.href = url;
  anchor.download = `memoria-brouillon-${pageId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
