# ADR 001 — Monorepo et monolithe modulaire

Statut : accepté — 2026-10-22.

**Décision.** pnpm + Turborepo ; Next.js App Router dans `apps/web`, NestJS dans `apps/api`, processus pg-boss dans `apps/worker`. Modules Nest métier : auth, workspaces, authorization, pages, blocks, databases, files, search, public-api, webhooks, audit. Chaque module aura les fichiers habituels `*.module.ts`, `*.controller.ts`, `*.service.ts`, puis des repositories si des requêtes le justifient. Les contrôleurs session et `/v1` appellent les mêmes services. Next.js ne lit jamais directement PostgreSQL.

**Alternatives.** API dans Next.js seulement ; microservices ; couche DDD générique avec bus de commandes.

**Raison.** La séparation web/API/worker répond aux clients moteurs de jeu et aux tâches différées sans imposer au développeur solo plusieurs systèmes distribués. Les contrats Zod sont partagés ; les dépendances serveur restent hors des composants client.

**Conséquences.** Cette session livre des emplacements typés, des contrats et un schéma, pas les applications exécutables. Les modules Nest, routes Next, Tailwind et composants shadcn/ui seront ajoutés lors des sessions correspondantes. Aucun service hébergé externe obligatoire. Cache Turbo local uniquement ; aucun workflow GitHub Actions.
