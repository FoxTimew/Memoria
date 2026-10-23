# ADR 001 — Monorepo et monolithe modulaire

Statut : accepté — 2026-10-22.

**Décision.** pnpm + Turborepo ; Next.js App Router dans `apps/web`, NestJS dans `apps/api`, processus pg-boss dans `apps/worker`. Modules Nest métier : auth, workspaces, authorization, pages, blocks, databases, files, search, public-api, webhooks, audit. Chaque module aura les fichiers habituels `*.module.ts`, `*.controller.ts`, `*.service.ts`, puis des repositories si des requêtes le justifient. Les contrôleurs session et `/v1` appellent les mêmes services. Next.js ne lit jamais directement PostgreSQL.

**Alternatives.** API dans Next.js seulement ; microservices ; couche DDD générique avec bus de commandes.

**Raison.** La séparation web/API/worker répond aux clients moteurs de jeu et aux tâches différées sans imposer au développeur solo plusieurs systèmes distribués. Les contrats Zod sont partagés ; les dépendances serveur restent hors des composants client.

**Conséquences.** Le cadrage a livré des emplacements typés, des contrats et un schéma. La session 1 ajoute le bootstrap Nest, les routes Next, les formulaires Tailwind et le worker pg-boss ; les composants d'éditeur et le reste des modules viendront ensuite. Le build des packages TypeScript source est décrit dans l'ADR 014. Aucun service hébergé externe obligatoire. Cache Turbo local uniquement ; aucun workflow GitHub Actions.
