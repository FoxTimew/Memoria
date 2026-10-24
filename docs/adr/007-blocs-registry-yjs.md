# ADR 007 — Blocs extensibles et service d'écriture unique

Statut : accepté — 2026-10-22.

**Décision du 2026-10-23, intégration à venir :** l'[ADR 017](017-collaboration-temps-reel.md) est accepté : Yjs en session 3, journal synchrone et projection asynchrone, writer unique hors éditeur attendant sa propre projection. La preuve isolée n'altère pas le fonctionnement SQL actif décrit ici. La séparation des modèles et de l'UI reste obligatoire ; les projections directes du prototype n'écrivent que ses fixtures temporaires.

**Complément session 2 (2026-10-23).** Les huit modèles standard sont enregistrés dans `/server` et leurs UI dans `/client`. Le texte riche utilise le contenu BlockNote, via les fonctions optionnelles `toEditorContent/fromEditorContent`, en plus du transport de props. Les tests d'aller-retour utilisent le vrai moteur ProseMirror, y compris les enfants imbriqués ; le writer SQL est implémenté. Normalisation du texte, limites et sauvegarde : [ADR 016](016-pages-editeur-et-sauvegarde.md). La future migration Yjs reste concentrée dans `BlockWriteService` ; aucun autre code applicatif n'écrit les tables de blocs.

**Décision.** Séparer le modèle et l'interface, y compris leurs graphes d'import :

- `BlockModel` dans `@memoria/blocks-core` : `type`, `version`, `schema`, `createDefault`, `migrate`, `toPlainText`. Le package ne dépend que de Zod, sans React, BlockNote, DOM ni JSX ; son registre ne contient aucun menu ou loader.
- `BlockUi` dans `@memoria/blocks-ui` : référence au modèle, menu, `loadEditor`, `loadReadonly` et contrat de l'adaptateur BlockNote (`spec`, `editorType`, conversions des props). L'UI peut importer le modèle ; la dépendance inverse est interdite.
- Chaque package de bloc expose exactement `./model` et `./ui`. L'exemple expose `characterCardModel` et `characterCardUi`. Aucun export racine mélangeant les deux, ni réexport de l'UI depuis le modèle.
- `@memoria/block-catalog/server` compose uniquement les exports `/model` et expose `blockModels` et `createBlockRegistry`. C'est l'unique entrée du catalogue pour NestJS, le worker, la recherche et les futurs imports. `@memoria/block-catalog/client` compose les exports `/ui`, expose `blockUis` et les fonctions d'intégration de l'éditeur. Les loaders `.tsx` ne sont accessibles que par cette branche.

Le registre ne connaît aucun bloc concret ; les deux entrées de `blocks/catalog` sont les racines de composition explicites. Un test vérifie qu'elles utilisent les mêmes modèles. `gamedev.character-card` fournit l'exemple complet ; les blocs standard sont intégrés depuis la session 2.

Un registry est une table qui associe un nom de type à son validateur et ses fonctions. L'ajout d'un bloc modifie le catalogue, pas le cœur ; le serveur n'a besoin ni de React ni du code de rendu pour valider. Les plugins sont des dépendances de confiance déployées avec l'application, jamais du code téléchargé d'un workspace.

**Alternatives.** Un contrat unique avec loaders différés, même si le serveur ne les appelle pas : rejeté car le graphe serveur reste couplé à l'UI. Switch central sur chaque type ; document HTML opaque ; import automatique de code tiers.

**Raison.** Les moteurs Unity/Unreal/Godot consomment des objets JSON versionnés avec identifiants stables. Les spécificités BlockNote restent dans les adaptateurs.

**Contrôle automatique.** `packages/blocks/catalog/src/server-boundary.test.ts`, lancé par `pnpm test`, `pnpm check` et le hook pre-push, parcourt l'entrée publique `/server`. TypeScript suit les imports/réexports transitifs, y compris les types ; esbuild parcourt aussi le JavaScript réellement exécuté des dépendances, sans élimination du code inutilisé et sans écrire de bundle. Toute référence à `react`, ses runtimes JSX, `react-dom` ou `@blocknote/*` fait échouer le test. Des cas négatifs injectent des réexports indirects et imports dynamiques pour vérifier le contrôle lui-même. Le manifeste de `blocks-core` est également contrôlé. Depuis la session 1, le build serveur refuse également les imports UI ; le choix du pipeline compilé, distinct de ce test de frontière, est documenté dans l'ADR 014.

**Invariant.** Toute écriture de blocs, y compris front, API publique, import, migration de contenu, restauration et purge, passe par `BlockWriteService`. Aucun repository voisin, worker ou script métier n'écrit directement ces tables. Les migrations SQL structurelles et fixtures de test sont les seules exceptions. Le service reçoit la transaction métier ; il valide le batch, les types/versions, l'appartenance des parents, l'absence de cycles et les fichiers liés, puis fait les écritures, incrémente la version, actualise la projection de recherche et ajoute audit/outbox. Son implémentation transactionnelle est livrée en session 2.

**Yjs ultérieur.** Import initial des blocs dans un document Yjs par page, sauvegarde des mises à jour/checkpoints binaires puis projection SQL pour recherche/API. Les commandes publiques sont traduites en opérations Yjs au même point d'écriture ; aucune seconde autorité JSON concurrente. Autorisations et validation restent côté serveur. La migration des contenus est persistée par le writer, jamais déclenchée silencieusement par un GET. Les modules UI lourds se chargent à la demande ; les specs requises sont chargées avant création du schéma BlockNote, pas ajoutées à un éditeur vivant. [Collaboration](https://www.blocknotejs.org/docs/features/collaboration).
