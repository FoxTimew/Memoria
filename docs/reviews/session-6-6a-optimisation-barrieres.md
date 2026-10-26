# Session 6a — profilage et réduction du travail sous barrière

26 octobre 2026. Suite au premier arrêt, le développeur a choisi de profiler puis de limiter le travail sous verrou, sans affaiblir les contrôles. **Le scénario de changement de rôle aux bornes passe maintenant les plafonds SQL et WSS.** Cette livraison débloque la preuve ; elle ne termine pas 6a et n’ouvre aucune interface ni nouvelle route applicative de bases.

## Fichiers à lire en priorité

1. [Migration 0023](../../packages/db/drizzle/0023_targeted_member_reconciliation.sql) : portée de réconciliation par personne, union des cibles, priorité absolue du calcul global. [Test PostgreSQL](../../apps/collab/src/testing/reconciliation.e2e.ts) : comparaison au calcul complet après chaque scénario.
2. [Profileur](../../apps/collab/src/testing/databases-profile.ts), [plans avant](evidence/session-6a-role-profile-before.json) et [après](evidence/session-6a-role-profile-after.json) : fonctions réellement chargées, plans, buffers, statistiques et trois séries conservées.
3. [Rédacteurs WSS](../../apps/collab/src/testing/database-wss-writers.ts), [proxy TLS isolé](../../apps/collab/src/testing/caddy-fixture.ts), [banc](../../apps/collab/src/testing/databases-load.ts) et [résultats finaux](evidence/session-6a-optimized-wss-measurement.json).
4. [ADR 020](../adr/020-droits-et-concurrence-des-bases.md) et [diagnostic initial](session-6-6a-barrieres.md), conservé avec son échec.

## Diagnostic présenté avant optimisation

La fixture reprend exactement les volumes du premier arrêt : **1 000 pages ordinaires, profondeur maximale 50, 50 bases, 50 000 lignes, 100 memberships et 5 000 partages**. Les lignes sont déjà exclues de la matérialisation des droits. Une mutation alterne le rôle d’un seul member/guest sans partage ; la base de données devait malgré tout comparer **56 000 couples stockés à 55 000 recalculés**, pour **1 000 changements sur une personne**.

`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)` mesure l’UPDATE et ses triggers immédiats. Le déclenchement explicite de la contrainte différée mesure la réconciliation, puis le commit est chronométré séparément. Les statistiques de fonctions sont lues avant/après : utiliser leur **différence**, pas additionner les compteurs cumulés ni les coûts inclusifs. Le CTE exact de réconciliation est expliqué séparément, avec la même mutation en attente, puis rollback. Aucune substitution de fonction de production.

| Phase avant optimisation, ms | p95 série 1 | p95 série 2 | p95 série 3 |    Médiane |
| ---------------------------- | ----------: | ----------: | ----------: | ---------: |
| UPDATE et triggers immédiats |       14,36 |       10,85 |       19,52 |      14,36 |
| Réconciliation différée      |      181,17 |      166,34 |      178,58 | **178,58** |
| Commit après réconciliation  |        3,05 |        1,92 |        2,39 |       2,39 |

Six échantillons par série : le p95 est ici le maximum, utile au diagnostic, sans prétention statistique de charge. Les médianes de phases ne s’additionnent pas pour reconstruire un p95 total.

Sur le plan représentatif de la série 2, les deux triggers prenant les barrières coûtent **4,72 et 4,09 ms** ; le trigger d’époque environ **0,19 ms**, celui de notification **0,02 ms**. Le coût dominant est bien la réconciliation, et non l’acquisition des barrières. Son plan séparé prend 191,46 ms avec l’instrumentation : lecture de 56 000 droits stockés, calcul de 55 000 droits (dont 127 500 lignes intermédiaires de jointure invités), deux tris sur disque de 2 584/2 760 Kio, élimination de 55 000 couples identiques, puis mise à jour des 1 000 changements. Les durées des nœuds sont inclusives : elles ne sont pas additionnées. Le plan et les buffers bruts permettent de vérifier ces attributions.

Cette conclusion a été communiquée avant toute optimisation applicative. [Journal avant](evidence/session-6a-role-profile-before.txt), secteur vérifié et RAM libre d’environ 3,94/3,93/3,94 Gio avant les séries. La tentative précédente refusée sous 3 Gio n’est pas une mesure valide.

## Modification et maintien des garanties

`page_access_pending.member_ids` contient les memberships affectés ; `NULL` signifie workspace entier. Rôle, sujet et grant peuvent borner leur effet à leurs personnes. Un grant déplacé entre sujets inclut ancien et nouveau membership. Plusieurs mutations dans une transaction réunissent leurs cibles. Arbre/workspace et sujet devenu introuvable lors d’une cascade déclenchent le calcul complet ; une portée globale ne peut jamais redevenir locale.

Le trigger différé lit **la portée finale en table**, et non le `NEW` du premier événement mis en attente. Le moteur complet utilisé par les aperçus est un appel au même moteur avec portée globale. Seuls les couples dont le niveau change reçoivent une nouvelle époque. Les verrous de bases/pages, le mutex de mutation et les contrôles session/assurance/politique/droits ne changent pas. **Aucun calcul n’est déplacé hors verrou** : aucune précondition optimiste supplémentaire n’est nécessaire pour cette optimisation. Rollback et publication des invalidations restent dans la transaction initiale.

Après optimisation, une rétrogradation ne lit que **1 000 couples stockés**, ne produit aucun droit pour cette personne sans partage et applique les 1 000 pertes. Les autres membres ne participent plus au recalcul. La promotion recalcule ses 1 000 accès. P95 de réconciliation isolée : **42,04 / 42,71 / 40,43 ms**, médiane **42,04 ms**. Plans complets : 30,03/30,39/26,66 ms ; les tris tiennent en mémoire. Sur le plan de la série 2, calcul des différences environ 2,08 ms et écriture des 1 000 époques environ 26,8 ms supplémentaires. [Journal après](evidence/session-6a-role-profile-after.txt). Ce sont des campagnes diagnostiques avant/après, pas la comparaison alternée finale avec main.

## Confirmation réellement reçue en WSS

Quatre providers Hocuspocus réels, trois lignes dans des bases distinctes et une page ordinaire, écrivent jusqu’à cinq fois par seconde chacun, avec décalage de 40 ms et une seule update en attente par rédacteur. Ils utilisent une vraie session Better Auth et un proxy Caddy isolé, issu de l’image locale existante. Le certificat et le nom d’hôte sont vérifiés avec sa CA explicite ; aucune désactivation TLS, modification de la confiance système ou reconfiguration du Caddy de développement.

Le chronomètre client commence avant la modification Yjs et s’arrête uniquement sur le **reçu durable portant le hash de cette update et sa génération**. Un simple état « synchronisé » ne suffit pas. Le serveur utilise réellement validation, droits, leadership, journal PostgreSQL, projection et accusé Hocuspocus. Un wrapper de chronométrage délègue sans substitution à `Room.update`.

La mutation de rôle reste SQL et inclut triggers, réconciliation et commit ; **son trajet HTTP n’est pas mesuré**. Le routage d’accès des trois lignes est un **adaptateur réservé à la fixture**, avec liste serveur fermée et époques base/cycle de vie figées, déléguant au résolveur réel. Il ne qualifie pas une nouvelle route native de tickets de lignes : les anciens tickets applicatifs de pages restent refusés pour ces lignes. Les quatre sockets utilisent un même compte owner ; ce n’est pas un test de cinquante comptes.

| Mesure en ms                        | p95 série 1 | p95 série 2 | p95 série 3 | Médiane des p95 | Plafond |
| ----------------------------------- | ----------: | ----------: | ----------: | --------------: | ------: |
| Mutation SQL complète               |       54,84 |       53,77 |       60,79 |       **54,84** |    <500 |
| Attente SQL observée des rédacteurs |       34,42 |       34,09 |       36,71 |       **34,42** |    <100 |
| Confirmation côté service           |       51,69 |       52,32 |       53,59 |       **52,32** |    <200 |
| Confirmation durable reçue en WSS   |       56,12 |       56,66 |       58,20 |       **56,66** |    <200 |

RAM libre avant les séries : **3,709 / 3,624 / 3,592 Gio** ; `BatteryStatus=2` à chaque fois. Échantillons de mutation hors deux premiers : **222/216/207** ; reçus WSS : **199/199/200**. Les médianes et chaque p95 individuel passent. [Journal complet](evidence/session-6a-optimized-wss-measurement.txt), assertions finales réussies.

L’attente SQL est échantillonnée via `pg_stat_activity`/`query_start`, exclusivement sur les appels bloqués à `content_lock_document`, avec intervalle demandé de 5 ms. C’est une **borne inférieure observée**, soumise à la cadence du sampler, et non une instrumentation exacte du temps d’attente interne PostgreSQL. Les écritures sans attente observée comptent zéro. La confirmation WSS, elle, inclut tout le délai perçu ; son p95 reste très inférieur à 100 ms, ce qui étaye aussi le passage du plafond de l’attente comprise dans ce trajet.

La pression de mutations est toujours continue sur la même fixture, mais la série finale dure **au moins dix secondes** (et au moins 32 mutations), contre 32 mutations fixes au premier arrêt. Ce changement donne assez de reçus WSS après accélération. Il interdit d’annoncer une comparaison alternée strictement identique ou un pourcentage de gain global. Les documents Yjs sont petits ; ni WAN, ni documents de 1 Mio, ni tableau/cellules ne sont qualifiés ici. Aucun benchmark ne tournait en parallèle d’une compilation ou d’un autre test.

## Tests réels et limites

| Sujet                               | Preuve exécutée                                                                                                                                                                                                                                                               | Limite                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Réconciliation ciblée               | [1 test PostgreSQL multi-scénarios](evidence/session-6a-reconciliation.txt) : rôle, grant, promotion avec nettoyage, union de deux personnes, global puis local et inversement, déplacement de grant, rollback, cascade, retrait ; comparaison au moteur complet après commit | Ne couvre pas toutes les combinaisons futures de sujets génériques                                        |
| Droits et WebSocket                 | [Suite 5a, 14/14](evidence/session-6a-optimized-sharing.txt) ; écriture réelle bloquée puis refusée après downgrade                                                                                                                                                           | Ne remplace pas les futures attaques de routes de lignes                                                  |
| Politique et assurance              | [Suite 4b, 13/13](evidence/session-6a-optimized-workspace-security.txt) ; assurance recontrôlée après attente, fin de grâce, révocation effective des sockets                                                                                                                 | Matériel MFA non retesté, aucun changement de facteurs                                                    |
| Invalidation ciblée et déplacements | [Partages, 7/7](evidence/session-6a-optimized-shares.txt)                                                                                                                                                                                                                     | Mutations globales d’arbre conservent le calcul global ; leur coût aux nouvelles bornes reste à qualifier |
| Invitations atomiques               | [1/1](evidence/session-6a-optimized-invitations.txt)                                                                                                                                                                                                                          | Pas de nouveau parcours d’invitation                                                                      |
| Contraintes SQL                     | [6/6](evidence/session-6a-optimized-db.txt), migrations jusqu’à 0023 sur schéma isolé                                                                                                                                                                                         | Pas de migration des données de travail                                                                   |
| Barrières et performance            | Deux ordres writer/révocation dans le prélude du banc, puis trois séries SQL/WSS réelles                                                                                                                                                                                      | CAS, relations, schéma et cycle de vie complets restent à prouver                                         |

Deux anciens tests ont d’abord échoué à cause de leur instrumentation antérieure à 6a : l’un cherchait le texte `FROM pages` au lieu de l’appel désormais utilisé `content_lock_document` ; l’autre essayait de modifier l’assurance depuis une troisième connexion alors que son propre bloqueur détenait le nouveau mutex de révocation. Ils observent désormais la vraie barrière, et la révocation d’assurance est faite dans la transaction bloqueuse avant libération. Les assertions de refus et d’absence d’effet sont conservées. Les suites complètes repassent ; aucun contrôle de production n’a été retiré pour les satisfaire.

`pnpm check` réussit, code zéro : hooks présents, lint/format, typage des douze packages, preuve Nest et **136 tests réussis / 6 SQL ignorés**, 25 fichiers réussis / 1 ignoré. Le contrôle complet est consigné dans [le journal final](evidence/session-6a-optimized-check.txt), résumé final de Vitest compris. Les six tests SQL, ignorés par le Vitest courant hors environnement DB, sont exécutés séparément ci-dessus. Aucun hook contourné.

## Guide de reproduction

1. Dans ce clone : `pnpm install`, `pnpm hooks:install`, `pnpm hooks:check`. Utiliser la configuration de développement existante et PostgreSQL/Caddy démarrés. Les tests créent et suppriment leurs propres schémas ; **ne pas lancer `pnpm db:migrate` sur les données de travail** à ce stade.
2. Lancer `pnpm test:collab:e2e --suite reconciliation`, puis `pnpm test:collab:e2e --suite databases-barriers` sans variables de mesure. Vérifier les sorties finales et le code zéro. Cela exerce les droits et les deux ordres de blocage sans benchmark.
3. Sur secteur, ≥3 Gio disponibles après préparation de fixture, sans autre charge, profiler avec les commandes ci-dessous. Lire `.local/session-6a-role-profile.json` et conserver le journal complet. Le fichier de preuve « avant » publié contient les définitions SQL de la référence `b2e4b5d` ; ne pas le remplacer par un résultat de la candidate.

```powershell
$env:MEMORIA_PROFILE_DATABASES='true'
pnpm test:collab:e2e --suite databases-barriers
Remove-Item Env:MEMORIA_PROFILE_DATABASES
```

4. Mesurer le trajet WSS complet ; prévoir Docker autorisé et l’image Caddy déjà présente. Le conteneur de test écoute sur un port TLS aléatoire local et est supprimé après la série. Le lanceur et le banc refusent la mesure si le protocole secteur/RAM n’est pas respecté.

```powershell
$env:MEMORIA_MEASURE_DATABASES='true'
$env:MEMORIA_DATABASE_WSS='true'
pnpm test:collab:e2e --suite databases-barriers
Remove-Item Env:MEMORIA_MEASURE_DATABASES, Env:MEMORIA_DATABASE_WSS
```

5. Dans `.local/session-6a-optimized-wss-measurement.json`, vérifier volumes, trois relevés secteur/RAM, échantillons et quatre métriques. Le journal doit finir par `passed:true` puis `EXIT_CODE=0`. Un échec impose l’arrêt et un diagnostic, pas une suppression du seuil.
6. Lancer `pnpm check` et `pnpm test:db`, puis les suites de partage/politique si ces chemins sont modifiés. Il n’y a pas encore de tableau à essayer dans le navigateur ; les parcours existants de session 5 restent disponibles.

Ce qui pourrait casser : une cible oubliée dans une transaction multi-mutations, une cascade réduite à tort à une personne, un ancien writer déployé sans les barrières 6a. Les tests d’union/globalité/oracle traitent les deux premiers ; le déploiement coordonné reste à livrer pour le troisième. Une future extension des types de sujets doit conserver le repli global jusqu’à preuve d’un périmètre plus précis.

**Suite restant à livrer dans 6a :** service CAS scalaire/ensemble et courses de cellules, relations/personnes aux bornes, routes/tickets/cache des lignes et attaques R12/S5-R11, autres chemins de révocation/projection, procédure de migration coordonnée et mesures finales. Tableau à 10 000 lignes, cellule pendant Yjs et comparaison alternée avec main restent non mesurés. Aucune acceptation de risque ni dérogation de seuil n’est déduite du passage de ce banc. Description intermédiaire mise à jour dans `.local/session-6a-pr.md` ; aucune PR créée ni fusionnée.
