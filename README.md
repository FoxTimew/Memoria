# Memoria

Socle d'un outil de documentation et de bases de données pour studios de jeu indépendants.
Cette étape prépare l'architecture : les applications web, API et worker ne démarrent pas encore.

## Prérequis et vérifications

- Node.js 24, pnpm 11.25.0, Docker Compose v2.
- `pnpm install --frozen-lockfile`, puis `pnpm hooks:install`.
- `pnpm check` : lint, format, types et tests. Le premier socle ne contient pas encore de tests métier.
- Hooks locaux Lefthook : lint/format et détection de secrets avant commit ; types/tests avant push.
- Aucune CI distante. Les hooks restent contournables : lancer `pnpm check` avant toute relecture.

## Infrastructure locale

1. `pnpm env:init` génère un `.env` ignoré avec des secrets aléatoires, sans écraser un fichier existant.
2. `pnpm infra:up` démarre PostgreSQL, MinIO, Mailpit et Caddy. La première compilation MinIO prend quelques minutes.
3. Exporter le certificat public : `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .local-root.crt`.
4. Faire confiance à ce certificat de développement dans le navigateur/système. Sous Windows, importer dans les autorités racines du compte courant. Ne jamais distribuer la clé privée de Caddy.
5. L'origine de l'application sera `https://localhost`, l'API étant routée vers le port 3001 et Next.js vers 3000. Les processus Node devront être joignables par Caddy via `host.docker.internal`. Sans applications démarrées, Caddy renvoie normalement 502.
6. Mailpit : `http://localhost:8025`. Console MinIO : `http://localhost:9001`. Créer le bucket privé `memoria` et renseigner les identifiants S3 dans `.env` lors du module fichiers.

MinIO est limité au développement local. Son dépôt communautaire est archivé ; l'image est construite depuis la version corrigée `RELEASE.2025-10-15T17-29-55Z`, les anciennes images publiques ne contenant pas ce correctif. Voir la [publication officielle](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z). La production utilisera un endpoint S3 maintenu et des identifiants dédiés.

`pnpm infra:down` conserve les volumes. Ne pas supprimer les volumes contenant des données utiles.

## Organisation initiale

`apps/web`, `apps/api`, `apps/worker` sont des emplacements typés sans logique applicative.
Les packages de contrats, de données et de blocs arrivent après le premier commit du socle.
