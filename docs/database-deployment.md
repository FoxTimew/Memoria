# Réglages de déploiement des bases

Statut 6a : preuve terminée, contrat de configuration testé ; aucune route de bases n'est encore ouverte. Les barrières, l'arborescence, les cellules sous Yjs et le tableau aux bornes passent leurs mesures, avec leur périmètre exact dans la [fiche finale](reviews/session-6-6a-finale.md). **Ne pas déployer les migrations de preuve sur les données de travail** avant la qualification de l'intégration et la procédure coordonnée définitives.

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

## État et migration coordonnée de 6a

Le [suivi cellules/arborescence](reviews/session-6-6a-cellules-et-arborescence.md) ajoute 0024 (portées de sous-arbre), 0025 (liste assignable et marque durable) et 0026 (barrières des définitions et FK cellule/base/propriété). Les tests appliquent toutes les migrations dans leurs schémas isolés, pas dans les données du développeur. La preuve SQL du tableau à 10 000 lignes / 50 propriétés est qualifiée le 26 octobre sous le nouveau protocole mémoire Windows/WSL, sans swap. Le code de cellules reste sans façade HTTP ; les bornes de création devront être contrôlées atomiquement dans les services 6b, pas par les seules tables.

Procédure de déploiement à exécuter après qualification complète, sans coexistence d’anciens et nouveaux writers : arrêter les processus API, collab et worker du même déploiement ; conserver PostgreSQL ; sauvegarder la base selon la procédure d’exploitation ; installer et construire la version retenue (`pnpm install --frozen-lockfile`, `pnpm build`), appliquer `pnpm db:migrate`, puis redémarrer ensemble API/collab/worker de cette version. Les connexions collaboratives doivent être fermées pendant cette maintenance. En développement, arrêter `pnpm dev`/`pnpm dev:collab` avant migration et les relancer après. Aucun reset des données de session 5 ni conversion de pages ordinaires en lignes. Ne pas laisser un ancien writer contourner les barrières après migration.

Les commandes de test (`pnpm proof:databases serve`, suites `database-cells`, `reconciliation-random`, `reconciliation-tree`) restent utilisables avant ce déploiement, avec PostgreSQL local. Le guide à deux clients indique la suppression de sa seule fixture. Les volumes Docker et les schémas de travail ne sont pas effacés par ces tests.

## Complément 6b

Les services HTTP utilisent désormais ces limites : 0027 maintient les compteurs physiques, la transaction de création valide les bornes après incrément et annule tout dépassement. La corbeille ne libère aucune place. Le titre et le corps initial d'une ligne, ses valeurs, son reçu et son événement initial sont commités ensemble ; un reçu identique reste idempotent pendant 24 heures, sous réserve d'accès encore valide. Les migrations amorcent les compteurs et l'index relationnel des données existantes.

La procédure de maintenance coordonnée ci-dessus reste obligatoire pour 0027. Les [tests HTTP et le guide manuel 6b](reviews/session-6-6b-services.md) remplacent les appels directs au noyau pour ces parcours. Le premier contrôle bloquant du tableau par la vraie route inclut guard, quotas, admission, compilateur et sérialisation ; il ne qualifie pas les déploiements au-delà des bornes mesurées. Les mesures HTTP finales de cellule avec Yjs, des droits sur bases remplies et la comparaison alternée collaborative restent en 6d.

La migration 0028 réutilise les barrières déjà acquises dans une transaction PostgreSQL. Le rôle SQL de l'application doit disposer de `TEMPORARY` sur sa base (vérifier `has_database_privilege(current_user,current_database(),'TEMP')`). Une table temporaire interne, vidée au commit et transactionnelle aux savepoints, accompagne chaque connexion qui mute les droits ; aucun changement de rôle utilisateur, de partage ou de politique n'est mis en cache. Conserver la maintenance coordonnée et les connexions SQL réservées aux services de confiance.
