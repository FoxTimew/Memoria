# Memoria

Outil de documentation et de bases de données pour studios de jeu indépendants.
Les sessions 1 à 3c fournissent Next.js, NestJS, le worker pg-boss et Hocuspocus exécutables, la connexion vérifiée, les workspaces, un arbre de pages et un éditeur BlockNote collaboratif avec recherche, corbeille, présence et cache local.
La référence est [ARCHITECTURE.md](ARCHITECTURE.md), accompagnée des [ADR](docs/adr/) et de la [relecture 3c : présence, reprise hors ligne et déconnexion](docs/reviews/session-3-3c-presence-cache.md). La [fiche 3b](docs/reviews/session-3-3b-editor.md) décrit aussi le démarrage et le reset des anciennes données de test.

Aucun utilisateur réel avant la fin de la session 4 et la finition de l'interface : les facteurs forts, les quotas NAT/par compte et la récupération de mot de passe restent à livrer. L'[ADR 017](docs/adr/017-collaboration-temps-reel.md) est accepté. Le service réel et le provider front communiquent en WSS ; le cache du corps est dans IndexedDB, effacé à la déconnexion. Rouvrir une page exige le réseau pour revérifier ses droits. La capacité mémoire 3d reste obligatoire avant 4, sur une nouvelle branche après fusion de 3c.

## Prérequis et vérifications

- Node.js 24, pnpm 11.25.0, Docker Compose v2.
- `pnpm install --frozen-lockfile`, puis `pnpm hooks:install`.

Les hooks Git natifs utilisent Node, sans Lefthook : secrets, lint et formatage des fichiers ajoutés à l'index avant commit ; typage, preuve Nest compilée et tests avant push. Après cette migration, relancer `pnpm hooks:install` dans chaque clone : seuls les anciens hooks générés de Memoria/Lefthook sont remplacés ; les hooks personnalisés et `core.hooksPath` sont préservés ou signalés. Un fichier partiellement ajouté à l'index est refusé avant les corrections automatiques, pour ne pas inclure des modifications non sélectionnées. [Installation, limites et tests](docs/reviews/session-6-hooks-natifs.md).

- `pnpm check` : lint, format, types, preuve de build/injection Nest et tests unitaires/contrats.
- `pnpm test:bootstrap` : compile puis exécute Nest avec les exports TypeScript du monorepo. Voir [ADR 014](docs/adr/014-build-serveur-typescript-source.md).
- `pnpm build` : vérifie les types, exécute la preuve Nest et construit les quatre applications. `pnpm start` les démarre ; `pnpm dev` active les reconstructions automatiques.
- `pnpm test:auth:e2e` : compile et démarre une application Nest isolée sur loopback, avec PostgreSQL réel, pour vérifier le guard global et les quotas par route. Aucun besoin de démarrer les applications ; les compteurs de test sont isolés et nettoyés.
- `pnpm test:pages:e2e` : compile Nest et vérifie les pages avec PostgreSQL réel, sessions owner/member, concurrence, rollback, recherche, corbeille et révocation. Peut être relancé immédiatement avec ses fixtures isolées.
- `pnpm test:e2e` : exécute les suites isolées d'authentification et de pages, puis le parcours HTTP réel à travers Caddy, PostgreSQL et Mailpit, après démarrage des applications. Utilise `.local-root.crt` pour vérifier TLS et nettoie uniquement ses comptes/workspaces/emails de test. Le parcours Caddy consomme les quotas de l'IP locale (deux inscriptions) : attendre dix minutes entre deux exécutions rapprochées. Voir [ADR 015](docs/adr/015-authentification-simple-et-workspaces.md).
- `pnpm test:db` : applique les migrations dans un schéma de test isolé sur le PostgreSQL Compose et vérifie l'intégrité des données.
- `pnpm test:collab:e2e` : tests permanents SQL/WebSocket du service réel ; sélection avec `--suite frontend`, `transport` ou `development`. Les mesures de capacité restent distinctes du parcours navigateur.
- `pnpm test:collab:browser` : deux contextes Edge isolés via HTTPS/WSS Caddy, avec comptes de test Mailpit ; présence, fermeture/reprise et déconnexion multi-onglets. Prérequis et journaux : fiche 3c.
- `pnpm db:migrate` : applique les migrations à la base configurée. `pnpm db:generate` : génère une migration après changement du schéma.
- `pnpm openapi:generate` : régénère le contrat OpenAPI de conception ; les endpoints HTTP seront implémentés ultérieurement.
- Hooks locaux Lefthook : lint/format et détection de secrets avant commit ; types/tests avant push.
- Aucune CI distante. Les hooks restent contournables : lancer `pnpm check` avant toute relecture.

## Infrastructure locale

1. `pnpm env:init` génère un `.env` ignoré avec des secrets aléatoires, sans écraser un fichier existant.
2. `pnpm infra:up` démarre PostgreSQL, MinIO, Mailpit et Caddy. La première compilation MinIO prend quelques minutes.
3. Exporter le certificat public : `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .local-root.crt`.
4. Faire confiance à ce certificat de développement dans le navigateur/système. Sous Windows, importer dans les autorités racines du compte courant. Ne jamais distribuer la clé privée de Caddy.
5. `pnpm db:migrate`, puis `pnpm dev`. Ouvrir `https://localhost` ; l'application propose l'inscription ou la connexion. API sur 3001, Next.js sur 3000, disponibilité du worker sur 3002, collaboration WSS sur 3003 et commandes HMAC privées sur 3004. Les ports Node doivent être joignables par Caddy via `host.docker.internal` ; ils ne doivent pas être exposés publiquement en production.
6. Créer un compte de test (mot de passe d'au moins 12 caractères), ouvrir l'email dans Mailpit à `http://localhost:8025`, suivre le lien, puis se connecter et créer un workspace. Ouvrir son nom, créer une page et taper `/` dans l'éditeur pour insérer un bloc. Le corps est collaboratif et enregistré automatiquement ; le titre possède son bouton séparé. Suivre la fiche 3b pour deux comptes, les anciennes pages et la coupure réseau.
7. Pour vérifier les exécutables compilés, arrêter `pnpm dev`, exécuter `pnpm build`, puis `pnpm start`. Ne pas lancer `dev` et `start` ensemble sur les mêmes ports. Dans un autre terminal : `pnpm test:e2e`.
8. Disponibilité : `https://localhost/api/health`, `https://localhost/api/health/worker` et `https://localhost/api/health/collab`. Le worker initialise son schéma pg-boss ; aucun job métier n'est encore enregistré.
9. Console MinIO : `http://localhost:9001`. Créer le bucket privé `memoria` et renseigner les identifiants S3 dans `.env` lors du module fichiers.

MinIO est limité au développement local. Son dépôt communautaire est archivé ; l'image est construite depuis la version corrigée `RELEASE.2025-10-15T17-29-55Z`, les anciennes images publiques ne contenant pas ce correctif. Voir la [publication officielle](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z). La production utilisera un endpoint S3 maintenu et des identifiants dédiés.

`pnpm infra:down` conserve les volumes. Ne pas supprimer les volumes contenant des données utiles.

Les commandes Node chargent le `.env` racine s'il existe ; les variables fournies par l'exploitant restent prioritaires. Les nouveaux ports ont des valeurs par défaut : inutile de régénérer un `.env` existant. En production, configurer `NODE_ENV=production`, `APP_ORIGIN` HTTPS, le secret Better Auth, PostgreSQL et SMTP ; déclarer les adresses exactes de Caddy dans `TRUSTED_PROXY_CIDRS` (liste séparée par des virgules). Le SMTP exige TLS implicite ou STARTTLS en production. En local, le proxy n'est reconnu que sur loopback par défaut ; ajouter son adresse/CIDR Docker réelle si nécessaire pour distinguer les IP des clients dans la limitation de débit. Ne pas déclarer tous les proxys de confiance.

Next.js impose son environnement selon la commande (`development` pour `dev`, `production` pour `build`/`start`) ; sa télémétrie est désactivée par le lanceur. Les requêtes de mutation nécessitent l'origine exacte de l'application. Les liens de vérification expirent après une heure et peuvent être renvoyés depuis l'interface.

## Livrables

`apps/web`, `apps/api`, `apps/worker`, `apps/collab` contiennent les applications exécutables.
`packages/db` contient le schéma Drizzle et ses migrations ; `packages/contracts` contient les schémas Zod partagés.
`packages/blocks` contient le registre et l'exemple complet `gamedev.character-card` avec adaptateur BlockNote, migration et rendu différé.
`packages/auth` configure l'authentification simple et conserve le test de compatibilité du schéma cible. Seul le plugin organization est actif ; les facteurs forts, clés publiques, invitations et partages restent dans leurs sessions prévues.
