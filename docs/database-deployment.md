# Réglages de déploiement des bases

Statut 6a : contrat de configuration testé ; aucune route de bases n'est encore ouverte. Le premier dépassement du banc de barrières a été résolu par une réconciliation ciblée (attente SQL observée 34,4 ms ; confirmation WSS 56,7 ms au p95 médian). La [fiche de suivi](reviews/session-6-6a-optimisation-barrieres.md) précise les limites : 6a reste incomplète. **Ne pas déployer les migrations de preuve sur les données de travail** avant la qualification et la procédure coordonnée définitives.

Les valeurs suivantes sont des **défauts de déploiement**, pas des constantes métier immuables. Elles sont lues une fois via `readDatabaseLimits`, hors des entrées HTTP. Les API/worker/collab du même déploiement doivent recevoir la même configuration. Une valeur non entière, nulle, négative, hors entier sûr ou des bornes incohérentes provoquent un échec explicite. Aucune hausse ne sera autorisée par une préférence utilisateur : toute hausse exige une mesure publiée au nouveau volume, puis une requalification des plafonds retenus. Baisser une borne ne supprime pas les données : les futurs services devront refuser la croissance, sans bloquer la lecture ou la purge.

| Variable                        |  Défaut |
| ------------------------------- | ------: |
| `DATABASE_ROWS_PER_BASE`        |   10000 |
| `DATABASE_ROWS_PER_WORKSPACE`   |   50000 |
| `DATABASE_BASES_PER_WORKSPACE`  |      50 |
| `DATABASE_PROPERTIES_PER_BASE`  |      50 |
| `DATABASE_OPTIONS_PER_PROPERTY` |     100 |
| `DATABASE_RELATION_VALUES`      |      50 |
| `DATABASE_SET_VALUES`           |      20 |
| `DATABASE_PAGE_SIZE`            |      50 |
| `DATABASE_MAX_PAGE_SIZE`        |     100 |
| `DATABASE_TEXT_CHARACTERS`      |    2000 |
| `DATABASE_URL_CHARACTERS`       |    2048 |
| `DATABASE_LABEL_CHARACTERS`     |      80 |
| `DATABASE_ASSIGNABLE_PEOPLE`    |     100 |
| `DATABASE_SAVED_VIEWS`          |       1 |
| `DATABASE_SORTS`                |       2 |
| `DATABASE_FILTERS`              |      10 |
| `DATABASE_FILTER_VALUES`        |      20 |
| `DATABASE_MUTATION_BYTES`       |   65536 |
| `DATABASE_QUERY_BYTES`          |   16384 |
| `DATABASE_ACCESS_IDS`           |     100 |
| `DATABASE_RESPONSE_BYTES`       | 4194304 |
| `DATABASE_QUERY_TIMEOUT_MS`     |    2000 |
| `DATABASE_CONCURRENT_QUERIES`   |      16 |
| `DATABASE_QUEUED_QUERIES`       |      32 |

`DATABASE_ROWS_PER_BASE` et `DATABASE_ROWS_PER_WORKSPACE` comptent les lignes archivées jusqu'à leur purge. Les bases comptent parmi les 1 000 pages ordinaires ; les lignes n'y comptent jamais. Les noms se mesurent en caractères Unicode ; les suffixes BYTES en octets ; TIMEOUT_MS en millisecondes. SET_VALUES s'applique aux personnes et multi-select. Ces paramètres n'augmentent ni le budget Yjs de 1 Mio/document ni les quotas HTTP. Les familles de quotas de la [fiche de cadrage](reviews/session-6-etape-1-cadrage.md) restent distinctes.

Exemple : conserver `DATABASE_ROWS_PER_BASE=10000` et `DATABASE_ROWS_PER_WORKSPACE=50000` dans l'environnement du déploiement ; omission = ces mêmes valeurs. Une hausse à 20 000 lignes/base exige au préalable le tableau trié/filtré à 20 000, les mutations de droits avec le nouveau volume total, les écritures Yjs/cellules concurrentes et le contrôle de RAM/secteur documenté. Ce document ne prétend pas que ces volumes sont déjà qualifiés.
