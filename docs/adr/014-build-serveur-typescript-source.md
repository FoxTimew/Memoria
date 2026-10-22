# ADR 014 — Build NestJS et packages TypeScript source

Statut : accepté — 2026-10-22. Vérifié en premier dans la session 1.

**Décision.** Conserver les exports TypeScript source des packages du monorepo. `scripts/build-server.mjs` transforme les sources avec TypeScript 5.9 (`experimentalDecorators`, `emitDecoratorMetadata`, modules ES), puis esbuild assemble les imports locaux dans un fichier ESM pour Node 24. Les dépendances serveur d'exécution déclarées dans les applications restent externes. Aucun chargeur TypeScript n'est nécessaire au démarrage du résultat compilé.

`transpileModule` ne vérifie pas les types : `pnpm typecheck` reste obligatoire, puis le build. Ce chemin est partagé par le build de production et la preuve de bootstrap. Les packages importés depuis le serveur restent sans UI ; le contrôle du catalogue `/server` continue à s'appliquer.

**Alternatives.** esbuild seul ne produit pas `design:paramtypes`. Le stripping natif Node ne prend pas en charge les décorateurs Nest. Compiler uniquement l'application avec `tsc` laisse ses imports nus pointer vers les exports `.ts` des packages. SWC ou un build préalable de chaque package sont possibles, mais ajoutent ici une configuration ou un compilateur supplémentaire. [Options TypeScript](https://www.typescriptlang.org/tsconfig/emitDecoratorMetadata.html), [compilation et métadonnées Nest](https://docs.nestjs.com/recipes/swc).

**Preuve.** `pnpm test:bootstrap` compile puis démarre `apps/api/src/bootstrap-probe.ts`. Le test vérifie la métadonnée de constructeur, l'injection effective par Nest et l'exécution d'imports provenant de `@memoria/block-catalog/server`, `@memoria/db` et `@memoria/contracts`. Résultat observé : `Nest decorators, dependency injection and workspace TypeScript exports: OK`. La vérification TypeScript de l'application passe également. Aucun écran ou service d'authentification n'a été nécessaire pour lever ce risque.

**Conséquences.** Importer les classes injectées comme valeurs (ou imports de namespace), jamais uniquement comme types si l'injection dépend de leurs métadonnées. Utiliser `@Inject` pour un token explicite. Les interfaces restent effacées à l'exécution. Les applications doivent déclarer les dépendances laissées externes dans leur propre `package.json`. Aucun secret n'est injecté dans le bundle ; la configuration vient de l'environnement au démarrage. Le watcher reconstruit avec ce même pipeline avant de redémarrer le processus.
