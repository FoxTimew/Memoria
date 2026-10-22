# Relecture — séparation du modèle et de l'interface des blocs

Branche : `feat/architecture`. Cette correction prépare le merge du cadrage ; la session 1 ne commence pas ici.

## Fichiers à lire en priorité

1. [ADR 007](../adr/007-blocs-registry-yjs.md) : la décision et le point d'écriture unique des blocs.
2. [BlockModel](../../packages/blocks/core/src/definition.ts) et [BlockUi](../../packages/blocks/ui/src/index.ts) : les données sont indépendantes de React ; le menu, les rendus et BlockNote appartiennent à l'interface.
3. [Catalogue serveur](../../packages/blocks/catalog/src/server.ts) et [catalogue client](../../packages/blocks/catalog/src/client.ts) : les imports réellement autorisés de chaque côté.
4. [Test de frontière](../../packages/blocks/catalog/src/server-boundary.test.ts) : il refuse une dépendance UI même si elle arrive par plusieurs imports ou par un chargement différé.
5. [Sessions suivantes](../../ARCHITECTURE.md#sessions-suivantes) : connexion simple, pages/éditeur, connexion forte, invités, puis la suite. Aucun utilisateur réel avant la fin de la session 3.

## Ce qui pourrait casser

- Les anciens imports racine de `@memoria/block-character-card` et `@memoria/block-catalog`, ainsi que `/editor`, ne fonctionnent plus. Utiliser `/model` ou `/ui` pour un bloc, `/server` ou `/client` pour le catalogue. `BlockDefinition` devient `BlockModel` ; le menu se trouve dans `BlockUi`, plus dans le registre serveur.
- Un nouveau bloc doit être ajouté aux deux catalogues. Le test de composition détecte un oubli ; la spec BlockNote doit toujours être chargée avant la création de l'éditeur.
- Le JSON stocké, les versions et la migration V1 → V2 de character-card restent identiques. Aucune migration SQL n'est nécessaire pour cette correction.
- Le démarrage NestJS et ses décorateurs avec les packages TypeScript source ne sont pas encore validés. Ce sera le tout premier travail de la session 1, avec un nouvel ADR. Le test utilisant esbuild ici ne valide pas le futur build NestJS.

## Comment tester manuellement

Depuis la racine du dépôt :

1. Exécuter `pnpm install --frozen-lockfile`, puis `pnpm check`.
2. Vérifier le contrôle ciblé avec `pnpm exec vitest run packages/blocks/catalog/src/server-boundary.test.ts`.
3. Vérifier qu'un processus Node peut importer le catalogue serveur, sans éditeur :

   ```sh
   pnpm --filter @memoria/block-catalog exec node --input-type=module -e "import { createBlockRegistry } from '@memoria/block-catalog/server'; console.log(createBlockRegistry().get('gamedev.character-card').version);"
   ```

   Le résultat attendu est `2`.

4. Pour voir la protection échouer, ajouter temporairement `export { characterCardUi } from '@memoria/block-character-card/ui';` dans `packages/blocks/catalog/src/server.ts`, puis relancer le contrôle ciblé. Il doit échouer avec `UI dependency forbidden`. Retirer cette ligne et relancer : le contrôle doit réussir.
5. Exécuter `pnpm exec vitest run packages/blocks` pour vérifier modèle, migration, rendu échappé, conversions des props et composition du schéma éditeur. Les conversions complètes de pages avec blocs imbriqués viendront en session 2.

Il n'y a pas encore d'écran ou de parcours navigateur à tester. Les applications Next/Nest/worker sont toujours des emplacements préparés.

## Contrôles de livraison

- `pnpm check` réussi : lint/format, types des 10 packages et 29 tests réussis. Les 6 tests PostgreSQL sont ignorés comme prévu dans cette commande ; le schéma n'a pas changé.
- Les 14 tests de blocs passent, dont 8 pour la frontière serveur. Les cas négatifs prouvent le rejet des imports UI indirects et d'une dépendance JavaScript masquée par ses déclarations de types.
- La commande Node ci-dessus a été exécutée : elle affiche bien `2`.
