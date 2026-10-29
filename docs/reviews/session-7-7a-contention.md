# Session 7a — contention du registre de fichiers

29 octobre 2026. Suite au profilage puis à la correction autorisés par le développeur. **Contention corrigée, nouvel arrêt sur le profil historique ; 7a non clôturée, 7b non commencée.** Cette fiche complète le [diagnostic initial](session-7-7a-transferts.md) sans effacer ses résultats.

## Fichiers à lire

1. [Migration 0033](../../packages/db/drizzle/0033_file_projection_latch.sql) et [FileBoundary](../../packages/db/src/file-boundary.ts) : les deux prises du même verrou métier.
2. [Tests PostgreSQL](../../apps/collab/src/testing/file-locks.e2e.ts) : lecteur FK de projection, insertion/retrait d'usage, exclusion du collecteur et rollback.
3. [Courses RustFS](../../apps/api/src/file-races.e2e.ts) : attache gagnante, rollback, collecteur gagnant, panne/reprise de suppression, révocation pendant l'attente.
4. [Profileur](../../apps/collab/src/testing/file-projection-profile.e2e.ts) et [rapport brut](evidence/session-7-7a-contention/projection-profile.json).

## Diagnostic présenté avant correction

Trois exécutions isolées de la projection réelle, 500 blocs, document contenu proche de 1 Mio, référence image au début. Les sondes secteur/mémoire/vmstat tournent dans le parent ; aucun autre test ou build pendant les séries. Les chiffres ci-dessous sont **trois durées**, pas des p95.

| Étape                                                     |   Série 1 |   Série 2 |   Série 3 |
| --------------------------------------------------------- | --------: | --------: | --------: |
| Projection complète                                       | 823,40 ms | 851,44 ms | 772,21 ms |
| Transaction SQL                                           | 617,00 ms | 600,87 ms | 566,54 ms |
| 500 insertions de blocs                                   | 518,43 ms | 510,50 ms | 483,20 ms |
| Depuis la fin de l'insertion de référence jusqu'au commit | 602,95 ms | 586,47 ms | 553,68 ms |
| EXPLAIN ANALYZE de l'insertion de référence, exécution PG |  0,356 ms |  0,473 ms |  0,381 ms |

Le verrou FK coûte peu à acquérir, mais dure jusqu'au commit des blocs, de la recherche, de l'audit et de l'outbox. La durée de rétention publiée est une borne inférieure, mesurée après la fin de l'insertion. Les plans et temps des triggers sont dans le rapport ; EXPLAIN est exécuté séparément sous rollback. Aucune conclusion de capacité globale n'est tirée de ce profilage.

Une première correction du seul verrou applicatif a été **insuffisante** : le trigger `file_usage_fence` reprenait `FOR UPDATE`. La [série intermédiaire arrêtée](evidence/session-7-7a-contention/latch-only-measurement.json) atteint 780,17 ms serveur, dont 767,40 ms au p95 dans le registre ; les percentiles ne s'additionnent pas. Le [test rouge](evidence/session-7-7a-contention/trigger-red.txt) identifie précisément le SQL du trigger dans le timeout. Ce résultat n'est ni supprimé ni compté comme série de la candidate finale.

## Correction et garanties

Le noyau et le trigger prennent `FOR NO KEY UPDATE`. Ce verrou reste incompatible avec les autres écritures métier et le `FOR UPDATE` du GC, mais autorise le `KEY SHARE` du lecteur FK. Les clés fichier/workspace sont immuables dans ces chemins. La migration remplace seulement la fonction du trigger ; les migrations déjà publiées restent intactes. Les contrôles `ready`, identité d'usage, auteur, droits, session, quotas, révision et fence du leader sont conservés. La projection reste atomique et asynchrone, sans déplacement de calcul hors transaction ni nouveau cache d'autorisation. [Sémantique PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS).

L'ancien test de diagnostic conserve un `FOR UPDATE` explicite comme témoin rouge. Le nouveau test utilise les migrations courantes, le noyau réel, les triggers d'insertion/retrait et un collecteur concurrent. Les courses de service utilisent réellement RustFS et PostgreSQL ; la promotion `validating → ready` et l'expiration des capacités sont des fixtures SQL, car le validateur de type est prévu en 7b. La « reprise » de suppression recrée le service, elle ne simule pas une destruction du stockage.

## Campagne après correction complète

Même banc WSS/Caddy, 10 vagues de chauffe puis 100 mesurées, pause de 100 ms entre vagues ; mêmes quotas et mêmes contrôles. Les p95 serveur mesurent le début de validation jusqu'à la fin de `Store.append`. Les reçus WSS incluent aussi le chemin client et la file. Les clients et le serveur sont dans le même processus du banc, les validateurs dans le pool de workers ; les sondes système restent dans le processus parent. Le détail des échantillons est dans le [rapport brut](evidence/session-7-7a-contention/measurement.json), avec le [journal complet et son arrêt](evidence/session-7-7a-contention/measurement.txt).

| Contenu 1 Mio — p95 serveur                |  Série 1 |  Série 2 |  Série 3 |  Médiane |
| ------------------------------------------ | -------: | -------: | -------: | -------: |
| Sans changement de référence, un auteur    | 14,40 ms | 14,82 ms | 13,12 ms | 14,40 ms |
| Sans changement de référence, deux auteurs | 13,55 ms | 12,26 ms | 14,87 ms | 13,55 ms |
| Ajout/retrait, un auteur                   | 26,94 ms | 25,18 ms | 25,25 ms | 25,25 ms |
| Ajout/retrait, deux auteurs                | 27,39 ms | 26,00 ms | 27,10 ms | 27,10 ms |

Ces douze p95 passent **<50 ms**. Avec références, les médianes des p95 WSS sont 31,82 ms (un auteur) et 51,57 ms (deux). Le p95 de prise des verrous reste entre 4,77 et 6,63 ms : la longue attente de projection n'est plus reproduite. Cela ne vaut pas comparaison alternée avec main.

| Historique 1 Mio — p95 serveur             |  Série 1 |       Série 2 | Série 3    |
| ------------------------------------------ | -------: | ------------: | ---------- |
| Sans changement de référence, un auteur    | 50,75 ms |      49,67 ms | Non lancée |
| Sans changement de référence, deux auteurs | 84,44 ms | **106,95 ms** | Non lancée |
| Ajout/retrait, un auteur                   | 44,76 ms |     Non lancé | Non lancée |
| Ajout/retrait, deux auteurs                | 86,99 ms |     Non lancé | Non lancée |

**Arrêt au dépassement de 100 ms**, sans nouvelle optimisation. Pas de médiane historique présentée sur deux séries. Au point d'arrêt, 23 des 200 commits mesurés dépassent 100 ms ; la transaction seule est à 11,44 ms au p95, sans appel au verrou ni au remplacement du registre de fichiers. Le temps avant `append`, calculé par différence **pour chaque échantillon apparié**, est à 98,87 ms au p95. Il inclut validation/préparation et attente d'ordonnancement ; ce n'est pas une mesure de CPU pur. Reçu WSS : 336,87 ms au p95, contre 299,78 ms au même scénario en série 1. Aucun diagnostic causal de GC/CPU/Yjs n'est affirmé à partir de ces seuls timers.

Les cinq séries lancées ont une hygiène conforme : secteur `BatteryStatus=2` ; Windows avant préparation 4,63–4,82 Gio, au début de mesure 4,09–4,50 Gio ; WSL 5,25–5,30 Gio disponibles. Les 60/60/60/137/78 intervalles vmstat ont si/so nuls et les compteurs swap ne changent pas. Les préparations et traces complètes sont versionnées dans le même dossier. La série intermédiaire du verrou applicatif seul et les trois profils de projection ont aussi leurs propres traces conservées.

### Suite proposée et limites

Recommandation : profiler le chemin historique à deux auteurs, en distinguant validation du candidat, attente du pool, boucle d'événements et coût des clients synthétiques ; mesurer séparément les clients avant d'attribuer l'écart au serveur. Conserver les seuils et le scénario à deux auteurs. Ce profilage et son éventuelle optimisation nécessitent le prochain arbitrage ; aucun gain annoncé sans mesure. Une dérogation sur le plafond historique reste une décision du développeur, pas une acceptation implicite.

La troisième série historique, le froid et la comparaison alternée finale avec main **ne sont pas exécutés après cet arrêt**. La clôture de 7a reste aussi soumise aux preuves complémentaires déjà listées dans la fiche transferts : réponses S3/SQL ambiguës et job tardif, capacité globale de staging/rapprochement des compteurs, navigateur/CORS réel et procédure des anciens fichiers sans registre. Les nouvelles courses GC ferment une partie de ces lacunes, pas toute la qualification crash/restauration. Le contrôle global de capacité et ces preuves ne sont pas implémentés dans ce correctif de contention.

## Guide de relecture et test

Contrôles terminés après correction : [verrous 2 tests](evidence/session-7-7a-contention/trigger-green.txt), [courses du collecteur 6 tests](evidence/session-7-7a-contention/races.txt), [frontières SQL/cellules/WSS 15 + 7 + 3 tests](evidence/session-7-7a-contention/boundaries.txt), [routes HTTP/GC 10 tests](evidence/session-7-7a-contention/routes.txt). `pnpm check` passe : **32 fichiers de tests réussis, 169 tests réussis, 6 ignorés**, hooks vérifiés, lint/formatage, typage récursif et preuve NestJS inclus. [Journal complet jusqu'au résumé Vitest](evidence/session-7-7a-contention/check.txt), [manifestes et empreintes](evidence/session-7-7a-contention/manifest.json). Les intégrations PostgreSQL/RustFS sont exécutées séparément ; les comptes Node incluent les tests parents. La conformité fournisseur 23/23 est celle déjà publiée dans la fiche transferts, pas une nouvelle campagne dans ce correctif.

1. Démarrer PostgreSQL et Docker, charger `.env` via les scripts fournis ; aucun reset des données utilisateur n'est nécessaire. Chaque intégration crée son schéma et son stockage jetables.
2. `node scripts/test-collab.mjs --suite file-locks` : attendre deux tests réussis, dont insertion et retrait pendant que la projection conserve sa référence non commitée.
3. `pnpm test:files:races` : vérifier que l'attache validée garde l'objet/quota, que son rollback autorise la collecte, que le GC gagnant interdit l'attache tardive et qu'une panne S3 ne libère pas le quota.
4. `pnpm test:files:boundaries` : droits par auteur, cellules et attaques WSS/HMAC. Le test de révocation reprend une transaction bloquée après archivage et exige son refus.
5. Après arbitrage du nouvel arrêt seulement : `pnpm profile:files` reproduit les trois profils de projection. `pnpm measure:files` mesure les reçus WSS et le commit du registre ; respecter le protocole secteur/mémoire et ne lancer aucun autre build/test simultané.

Une migration manquante laisse le verrou du trigger en place et recrée la contention : déployer la migration avec le code. Ce correctif ne prétend pas accélérer les 500 insertions de projection elles-mêmes.
