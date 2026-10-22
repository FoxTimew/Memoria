# Memoria

Outil de documentation et de bases de données pour studios de jeu indépendants.
La session 1 fournit Next.js, NestJS et le worker pg-boss exécutables, l'inscription email/mot de passe, la vérification d'email, la connexion et la création de workspaces.
La référence est [ARCHITECTURE.md](ARCHITECTURE.md), accompagnée des [ADR](docs/adr/) et de la [relecture de session 1](docs/reviews/session-1-bootstrap-auth.md).

Aucun utilisateur réel avant la fin de la session 3 : les facteurs forts et la politique de workspace ne sont pas encore activés.

## Prérequis et vérifications

- Node.js 24, pnpm 11.25.0, Docker Compose v2.
- `pnpm install --frozen-lockfile`, puis `pnpm hooks:install`.
- `pnpm check` : lint, format, types, preuve de build/injection Nest et tests unitaires/contrats.
- `pnpm test:bootstrap` : compile puis exécute Nest avec les exports TypeScript du monorepo. Voir [ADR 014](docs/adr/014-build-serveur-typescript-source.md).
- `pnpm build` : vérifie les types, exécute la preuve Nest et construit les trois applications. `pnpm start` les démarre ; `pnpm dev` active les reconstructions automatiques.
- `pnpm test:e2e` : parcours HTTP réel à travers Caddy, PostgreSQL et Mailpit, après démarrage des applications. Utilise `.local-root.crt` pour vérifier TLS et nettoie uniquement ses comptes/workspaces/emails de test.
- `pnpm test:db` : applique les migrations dans un schéma de test isolé sur le PostgreSQL Compose et vérifie l'intégrité des données.
- `pnpm db:migrate` : applique les migrations à la base configurée. `pnpm db:generate` : génère une migration après changement du schéma.
- `pnpm openapi:generate` : régénère le contrat OpenAPI de conception ; les endpoints HTTP seront implémentés ultérieurement.
- Hooks locaux Lefthook : lint/format et détection de secrets avant commit ; types/tests avant push.
- Aucune CI distante. Les hooks restent contournables : lancer `pnpm check` avant toute relecture.

## Infrastructure locale

1. `pnpm env:init` génère un `.env` ignoré avec des secrets aléatoires, sans écraser un fichier existant.
2. `pnpm infra:up` démarre PostgreSQL, MinIO, Mailpit et Caddy. La première compilation MinIO prend quelques minutes.
3. Exporter le certificat public : `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .local-root.crt`.
4. Faire confiance à ce certificat de développement dans le navigateur/système. Sous Windows, importer dans les autorités racines du compte courant. Ne jamais distribuer la clé privée de Caddy.
5. `pnpm db:migrate`, puis `pnpm dev`. Ouvrir `https://localhost` ; l'application propose l'inscription ou la connexion. API sur 3001, Next.js sur 3000, disponibilité du worker sur 3002. Les ports Node doivent être joignables par Caddy via `host.docker.internal` ; ils ne doivent pas être exposés publiquement en production.
6. Créer un compte de test (mot de passe d'au moins 12 caractères), ouvrir l'email dans Mailpit à `http://localhost:8025`, suivre le lien, puis se connecter et créer un workspace.
7. Pour vérifier les exécutables compilés, arrêter `pnpm dev`, exécuter `pnpm build`, puis `pnpm start`. Ne pas lancer `dev` et `start` ensemble sur les mêmes ports. Dans un autre terminal : `pnpm test:e2e`.
8. Disponibilité : `https://localhost/api/health` et `https://localhost/api/health/worker`. Le worker initialise son schéma pg-boss ; aucun job métier n'est encore enregistré.
9. Console MinIO : `http://localhost:9001`. Créer le bucket privé `memoria` et renseigner les identifiants S3 dans `.env` lors du module fichiers.

MinIO est limité au développement local. Son dépôt communautaire est archivé ; l'image est construite depuis la version corrigée `RELEASE.2025-10-15T17-29-55Z`, les anciennes images publiques ne contenant pas ce correctif. Voir la [publication officielle](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z). La production utilisera un endpoint S3 maintenu et des identifiants dédiés.

`pnpm infra:down` conserve les volumes. Ne pas supprimer les volumes contenant des données utiles.

Les commandes Node chargent le `.env` racine s'il existe ; les variables fournies par l'exploitant restent prioritaires. Les nouveaux ports ont des valeurs par défaut : inutile de régénérer un `.env` existant. En production, configurer `NODE_ENV=production`, `APP_ORIGIN` HTTPS, le secret Better Auth, PostgreSQL et SMTP ; déclarer les adresses exactes de Caddy dans `TRUSTED_PROXY_CIDRS` (liste séparée par des virgules). Le SMTP exige TLS implicite ou STARTTLS en production. En local, le proxy n'est reconnu que sur loopback par défaut ; ajouter son adresse/CIDR Docker réelle si nécessaire pour distinguer les IP des clients dans la limitation de débit. Ne pas déclarer tous les proxys de confiance.

Next.js impose son environnement selon la commande (`development` pour `dev`, `production` pour `build`/`start`) ; sa télémétrie est désactivée par le lanceur. Les requêtes de mutation nécessitent l'origine exacte de l'application. Les liens de vérification expirent après une heure et peuvent être renvoyés depuis l'interface.

## Livrables

`apps/web`, `apps/api`, `apps/worker` contiennent les applications exécutables.
`packages/db` contient le schéma Drizzle et ses migrations ; `packages/contracts` contient les schémas Zod partagés.
`packages/blocks` contient le registre et l'exemple complet `gamedev.character-card` avec adaptateur BlockNote, migration et rendu différé.
`packages/auth` configure l'authentification simple et conserve le test de compatibilité du schéma cible. Seul le plugin organization est actif ; les facteurs forts, clés publiques, invitations et partages restent dans leurs sessions prévues.
