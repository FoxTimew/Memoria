# ADR 013 — Qualité locale et découpage des sessions

Statut : accepté — 2026-10-22.

**Décision.** TypeScript strict sans `any`, ESLint + Prettier, Vitest, Lefthook. `pnpm check` lance lint/format, typecheck Turbo, tests unitaires/contrats. `pnpm test:db` applique les migrations au PostgreSQL Compose dans un schéma temporaire unique et teste l'intégrité SQL. Les tests e2e HTTP arriveront avec les routes réelles.

**Alternatives.** GitHub Actions ; tests simulant uniquement Drizzle ; écrire un MVP complet pendant le cadrage.

**Raison.** Respecter le développement local et obtenir des preuves sur les contraintes réelles sans prétendre avoir validé des endpoints absents.

**Conséquences.** Pre-commit : détection de chemins sensibles, lint et format des fichiers indexés. Pre-push : types et tests. Appels Node directs dans les hooks pour fonctionner depuis Git Bash sous Windows. Les rétentions/SSRF/auth/courses ne seront réputées fonctionnelles qu'après tests de leur module. Les versions npm sont exactes dans le lockfile ; TypeScript 5.9 reste dans la plage supportée par typescript-eslint, même si une version majeure plus récente existe.

Une branche par module ; cette session : `feat/architecture`. Commits Conventional Commits après `pnpm check`, vérification de l'index et absence de secrets. Pas de merge automatique dans main, ni force push ou réécriture de son historique. Le schéma a son commit après celui du socle ; blocs/contrats puis documentation sont séparés. Les ADR évoluent quand une décision change, avec justification ; ne pas traiter un élément planifié comme livré.
