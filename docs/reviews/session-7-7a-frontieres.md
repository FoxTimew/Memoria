# Session 7a — frontières indépendantes du fournisseur

**29 octobre 2026.** Le choix de production reste ouvert dans le [comparatif](session-7-7a-decision-stockage.md). MinIO reste local, le patch SeaweedFS temporaire. Cette livraison poursuit **7a**, sans la clôturer : registre et noyaux transactionnels raccordés au journal collaboratif, admissions internes et cellule fichiers ; pas encore de routes HTTP de téléversement ni de service de lecture. **7b non commencée.**

## Fichiers à lire en priorité

1. [Migrations 0030](../../packages/db/drizzle/0030_file_boundary.sql) et [0031](../../packages/db/drizzle/0031_file_cell_kind.sql), [frontière transactionnelle](../../packages/db/src/file-boundary.ts), [cellules](../../packages/db/src/file-cells.ts).
2. [Candidat par auteur](../../apps/collab/src/service/incremental-replica.ts), [salle](../../apps/collab/src/service/room.ts), [commit du journal](../../apps/collab/src/service/store.ts). Le registre `file_usages` est autoritatif ; `file_references` reste une projection asynchrone.
3. [Attaques SQL/Room](../../apps/collab/src/testing/files.e2e.ts), [vraies attaques WSS/HMAC](../../apps/collab/src/testing/files-wire.e2e.ts), [cellules et courses](../../apps/collab/src/testing/file-cells.e2e.ts), [limites configurables](../../packages/db/src/file-limits.ts).

## Comportement et invariants

Les ajouts de références sont attribués à chaque contribution du lot Yjs, y compris un ajout retiré par une contribution suivante. Le candidat est parcouru dans l'ordre des contributions ; on ne valide pas tous les fichiers avec les droits du premier auteur. Un lot refusé repasse la séparation existante des contributions. Une référence présente dans une update non validée ne devient jamais une source autorisée pour un autre auteur.

Une nouvelle référence exige edit à destination et read sur une référence source vivante, ou une intention propre déjà validée et encore attachable sur cette destination. Le choix de source est fait hors transaction puis **recontrôlé sous verrou**, avec session, assurance, politique et droits actuels. Un UUID connu et l'appartenance au workspace ne suffisent pas. Une référence attachée devient indépendante : retirer l'accès à la source initiale ne retire pas le droit acquis par la destination.

Ordre des verrous : barrière partagée du workspace, bases/lignes et pages sources/destination triées, quota des références de la page, fichiers triés, puis clôture du leadership pour le journal. Le quota de page est partagé entre cellules et blocs ; deux cellules disjointes ne peuvent le dépasser ensemble. Les mutations d'accès conservent leur barrière exclusive. Aucun appel S3 sous transaction SQL. Les frappes sans changement de référence ne prennent pas ces verrous fichiers ; elles avancent toutefois la révision du registre avec le journal.

`file_usages` et sa révision sont commités avec l'update Yjs, ou avec la version CAS de cellule. Un échec tardif annule le tout. Les fichiers en suppression refusent une nouvelle référence, même par insertion SQL. **Le job de GC et la course complète suppression S3/attache restent à livrer** ; le trigger ne constitue pas à lui seul un GC sûr. Les propriétés/lignes archivées conservent leurs usages retenus.

L'admission réserve atomiquement les octets et le nombre de fichiers, y compris les intentions en cours et 10 Mio de marge de dérivés. Même clé et même demande = même intention ; même clé et demande différente = conflit. Les signatures futures s'appuieront sur des baux SQL : compte/instance, bucket d'octets et plan immuable (numéro, taille, SHA-256). Un progrès client ne libère rien ; un renouvellement ne peut changer le checksum. Un rejeu idempotent retourne **l'expiration initiale**, jamais une nouvelle fenêtre gratuite. Le futur signataire doit refuser un bail expiré. Les lignes de baux doivent rester jusqu'à clôture de l'intention pour conserver le plan ; leur purge et le rapprochement des compteurs ne sont pas implémentés ici.

Le noyau cellule accepte plusieurs fichiers, CAS par cellule et précondition de schéma ; les valeurs invisibles restent conservées et ne rendent qu'un marqueur neutre. Le type SQL `files` existe, mais le schéma HTTP général ne l'ouvre pas encore : il faut les sélecteurs, les contrats d'erreur et les attaques de routes avant exposition. Aucune donnée binaire n'est mise dans PostgreSQL ou Yjs.

## Preuves réelles et absences — R12

Les [journaux complets](evidence/session-7-7a-frontieres/) séparent les tests fonctionnels des mesures. Les totaux Node incluent les tests parents : 15 pour fichiers (13 sous-scénarios), 7 pour cellules (6 sous-scénarios), 3 pour WSS/HMAC (2 sous-scénarios). Pas de test ignoré dans ces trois suites. `files-final.txt` est la relance finale enrichie de la séparation des quotas compte/instance ; `boundaries.txt` conserve la première série complète à 14/7/3. Non-régression : journal 3/3 et transport 13/13 (douze scénarios plus le parent). `pnpm check` réussit : hooks, lint, types, bootstrap Nest, **168 tests Vitest réussis / 6 ignorés** ; les six tests SQL réclament leur banc dédié, distinct des suites réelles exécutées ici.

| Frontière / attaque                                                                            | Preuve exécutée                                                                                         | Ce qui reste absent                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Tenant étranger, fichier connu sans source, destination read                                   | `files.e2e.ts`, vrai PostgreSQL et Room                                                                 | Combinaisons exhaustives d'archive/restauration, MFA et reprise navigateur |
| Lot hostile empruntant les droits du membre                                                    | Même suite, attaquant refusé et contribution légitime confirmée ; test unitaire ajout puis retrait      | Charge multi-auteurs et comparaison de performance finale                  |
| WSS Caddy, session Better Auth, UUID injecté dans une vraie update                             | `files-wire.e2e.ts`, socket fautive fermée, autre socket encore utilisable                              | Faux cache navigateur et undo de fichier sur l'interface finale            |
| HMAC valide contenant un fichier inaccessible                                                  | Même suite, rejet sans journal ; absence de nom/clé objet dans erreur                                   | Audit complet des logs API/Caddy/S3 et nouvelles routes                    |
| Référence durable avant projection, source retirée après plan, rollback tardif                 | `files.e2e.ts`, assertions SQL après chaque opération                                                   | Restauration réelle d'une sauvegarde et reconstruction du registre         |
| Réservations simultanées, idempotence, quota workspace, baux, checksum, session expirée        | Vrai SQL, horloge PG et courses concurrentes ; états completing/validating/ready/deleting non signables | Quotas HTTP U/P/L/M/D et header forgé : routes pas ouvertes                |
| Cellules indépendantes, conflit de même cellule, schéma, droits guest, valeur cachée, rollback | `file-cells.e2e.ts`                                                                                     | API/tableau fichiers et ergonomie de réapplication du conflit              |
| Deux cellules distinctes au quota de page                                                      | Même suite : exactement une admission, total borné                                                      | Charge longue et bornes maximales                                          |
| Fichier déjà deleting                                                                          | Trigger SQL et journal refusent une nouvelle attache                                                    | GC concurrent en flux S3, crash et libération confirmée du quota           |
| Multipart MinIO et SeaweedFS temporaire                                                        | 23/23 par fixture, contrôle relancé ; alternatif RustFS 23/23 / Garage 18/23                            | Flux applicatif complet intention → S3 → validation → READY                |

Les points WSS et HMAC utilisent leurs limites de transport existantes ; aucune nouvelle route ne reçoit par avance l'étiquette « sécurisée ». La matrice prévisionnelle U/P/L/M/D du [cadrage](session-7-etape-1-cadrage.md#inventaire-prévisionnel-des-routes-et-quotas--r12--s5-r11) reste à exécuter à l'ouverture des contrôleurs. Les compteurs internes d'octets/concurrence ne remplacent pas les quotas de requêtes.

## Guide de vérification

### Réglages de déploiement du noyau

Valeurs lues au démarrage par `readFileLimits`, nombres entiers strictement positifs ; une valeur invalide échoue explicitement. Aucun relèvement sans mesure. Tous les processus raccordés devront partager ces réglages. Les quotas de routes restent ceux du cadrage.

| Variable                                                             | Défaut                 |
| -------------------------------------------------------------------- | ---------------------- |
| `FILES_MAX_BYTES`                                                    | 5368709120 (5 Gio)     |
| `FILES_WORKSPACE_BYTES`                                              | 268435456000 (250 Gio) |
| `FILES_WORKSPACE_FILES`                                              | 100000                 |
| `FILES_PAGE_REFERENCES` / `FILES_FILE_USAGES` / `FILES_CELL_FILES`   | 100 / 1000 / 20        |
| `FILES_DERIVATIVE_BYTES`                                             | 10485760 (10 Mio)      |
| `FILES_PART_BYTES`                                                   | 16777216 (16 Mio)      |
| `FILES_BYTES_PER_SECOND` / `FILES_BURST_BYTES`                       | 10485760 / 67108864    |
| `FILES_ACTIVE_FILES` / `FILES_ACTIVE_PARTS` / `FILES_INSTANCE_PARTS` | 2 / 4 / 20             |
| `FILES_URL_SECONDS`                                                  | 120                    |
| `FILES_RESUME_SECONDS` / `FILES_ABSOLUTE_SECONDS`                    | 86400 / 604800         |

La borne multipart de 10 000 parties reste celle du protocole S3. Les réservations de dérivés sont conservatrices pour tous les types jusqu'au verdict du futur worker.

### Parcours reproductible

1. Depuis ce clone, avec Node/pnpm, `.env` local et PostgreSQL démarré, lancer `pnpm check`. Il doit finir sur le résumé Vitest ; ne pas contourner les hooks.
2. Lancer `pnpm test:files:boundaries`. Les fixtures créent leurs schémas et comptes jetables. Attendre les trois sorties 0 ; le refus `FILE_UNAVAILABLE` dans le journal WSS est une attaque attendue, pas une autorisation échouée silencieusement.
3. Cette dernière suite pilote deux clients authentifiés sur le vrai WSS TLS de Caddy : le premier injecte un UUID sans source, le second écrit normalement ; vérifier la fermeture du premier et le reçu durable du second. L'instance de test est distincte de l'application.
4. Dans les tests cellules, vérifier que le guest edit joint l'asset de sa tâche, que le guest read ne le retire pas, que le conflit conserve la valeur en base et qu'un fichier masqué ne révèle ni nom ni identifiant. **Il n'y a pas encore de sélecteur fichiers à tester manuellement dans l'interface** ; il vient en 7c.
5. Avec Docker, lancer `pnpm test:storage --candidate` (MinIO local et SeaweedFS corrigé, 23/23 chacun), puis `pnpm test:storage:alternatives` (RustFS 23/23, Garage rouge attendu). Les conteneurs sont privés au loopback et jetables. Ne pas utiliser de bucket réel.
6. Lire le [comparatif](session-7-7a-decision-stockage.md), puis les fichiers `.local/seaweedfs-upstream/issue.md` et `pull-request.md`. Rien n'a été envoyé à l'amont. Le fournisseur de production reste à choisir avant 7b.

## Ce qui pourrait casser et ce qui n'est pas encore qualifié

Les migrations ont été exécutées sur les schémas de test, **pas appliquées automatiquement aux données du développeur**. Au premier chargement, un document ancien sans fichiers initialise son suivi. Un document contenant déjà des références sans registre vérifiable refuse l'ouverture avec `FILE_LEDGER_REBUILD_REQUIRED` : pas de reconstruction implicite depuis une projection potentiellement en retard. Les données sont de test ; préparer la procédure contrôlée de reconstruction/reset avant d'activer les fichiers sur un ancien jeu de données. Aucune suppression de contenu n'est effectuée par cette livraison.

Le registre et les intentions ajoutent des données personnelles indirectes et des contraintes FK. Leur nettoyage/anonymisation doit être intégré à la rétention RGPD pré-pilote, sans supprimer les actifs du workspace avec leur auteur. Les réservations ne se libèrent pas encore automatiquement : aucun trafic utilisateur n'est ouvert avant les jobs de clôture/réconciliation. Les marges de disque opérateur, le pipeline de validation, les dérivés, la lecture révocable et l'absence de fichier complet en mémoire restent à prouver dans le raccordement de transport.

**Aucune mesure de performance nouvelle n'est revendiquée.** La validation successive des auteurs et le contrôle de registre au chargement doivent passer les plafonds 7a et la comparaison avec main avant clôture. Les durées imprimées par Node test ne sont pas des p95 selon le protocole secteur/RAM/swap/trois séries. Les reçus PostgreSQL pour remplacer ListParts restent une option de conception, pas ces baux d'admission.
