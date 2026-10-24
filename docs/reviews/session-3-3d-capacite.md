# 3d — pool et mémoire proportionnelle, arrêt sur la non-régression

24 octobre 2026. Branche `codex/session-3d-collaboration-capacity`. **3d n'est pas validée et la session 4 ne démarre pas.** Code candidat : `875c63f76783e5d28c875bd954d646d8fac31fae`. La borne reste 1 Mio ; aucune fusion ni modification des seuils pour faire passer un résultat.

## Résultat et décision à prendre

Les médianes respectent les plafonds absolus de 50 / 100 ms pour les updates contenu / historique et de 500 ms à froid. En revanche, trois métriques dépassent la marge de régression autorisée de 10 %. La validation est donc arrêtée. La série froide candidate n°1 échoue aussi individuellement à 500,15 ms sur l'historique ; cet échec est conservé.

| Configuration             | Mesure (ms)       | p95 série 1 | p95 série 2 | p95 série 3 |     Médiane |
| ------------------------- | ----------------- | ----------: | ----------: | ----------: | ----------: |
| Référence `665a829`       | Update contenu    |      12,903 |      14,259 |      13,688 |  **13,688** |
| Référence                 | Update historique |      49,637 |      55,159 |      55,180 |  **55,159** |
| Référence                 | Froid contenu     |     221,473 |     264,889 |     230,564 | **230,564** |
| Référence                 | Froid historique  |     427,941 |     503,525 |     433,232 | **433,232** |
| Pool initial exploratoire | Update contenu    |      14,572 |      14,276 |      14,202 |  **14,276** |
| Pool initial              | Update historique |      56,148 |      51,569 |      53,807 |  **53,807** |
| Pool initial              | Froid contenu     |     201,804 |     197,323 |     198,901 | **198,901** |
| Pool initial              | Froid historique  |     325,392 |     349,280 |     327,882 | **327,882** |
| Candidate `875c63f`       | Update contenu    |      21,267 |      21,901 |      21,295 |  **21,295** |
| Candidate                 | Update historique |      83,426 |      76,727 |      81,273 |  **81,273** |
| Candidate                 | Froid contenu     |     383,129 |     398,629 |     368,920 | **383,129** |
| Candidate                 | Froid historique  |     500,154 |     454,078 |     437,489 | **454,078** |

Écarts de la candidate à la référence, dans cet ordre : **+55,6 %, +47,3 %, +66,2 %, +4,8 %**. Le runner final termine par **EXIT_CODE=1**. La référence a également un échec individuel (froid n°2) ; son runner synthétique termine par 0 car les critères demandés portent sur les médianes. Aucun échantillon n'est retiré. Les anciennes valeurs isolées de `665a829` (16,16 / 55,68 / 296,24 / 438,81 ms) restent dans la fiche précédente ; même cette comparaison moins stricte ne ferait pas passer la candidate.

Le pool initial passait les critères. C'est une configuration exploratoire non commitée, avant les classes de réservation et les dernières protections ; son manifeste contient l'empreinte du diff et les noms des fichiers alors non suivis, pas leur contenu. Elle ne remplace pas la candidate reproductible `875c63f`. La référence utilise le code applicatif `665a829`, avec seulement le seuil historique du test adapté à la nouvelle règle et le runner de séries ajouté.

**Option recommandée à autoriser :** comparer référence et candidate en alternance, avec exactement le même runner, les mêmes fixtures et les mêmes relevés de ressources, puis isoler les changements responsables si l'écart persiste. Cela distingue un effet du code d'une dérive des conditions sans relever les seuils. Autre option : revenir au pool initial puis réintroduire les réservations et protections une à une ; c'est plus long et la référence temporelle resterait à contrôler. Aucun diagnostic causal supplémentaire ni nouvelle optimisation n'est lancé après cet arrêt.

## Méthode et journaux complets

Ryzen 7 5800H, 16 CPU logiques disponibles, Windows, Node 24.21, PostgreSQL 17.11 local Docker, durabilité SQL conservée. Batterie : Windows indique état 1 et 27 % lors des séries finales ; mode « Legion Balance Mode ». Aucun réglage d'alimentation modifié. Cela décrit le contexte, **sans attribuer l'écart à la batterie**. Les configurations ne sont pas alternées dans cette campagne et plusieurs heures les séparent.

RAM libre avant chaque série, ordre chaud 1 / froid 1 / chaud 2 / froid 2 / chaud 3 / froid 3 :

| Configuration | RAM libre relevée (Gio)                       |
| ------------- | --------------------------------------------- |
| Référence     | 3,152 ; 3,159 ; 3,113 ; 3,129 ; 3,089 ; 3,107 |
| Pool initial  | 3,276 ; 3,375 ; 3,349 ; 3,344 ; 3,364 ; 3,350 |
| Candidate     | 4,123 ; 4,185 ; 4,208 ; 4,210 ; 4,245 ; 4,255 |

Deux arrêts préparatoires pour RAM insuffisante ont entraîné une demande de fermeture d'applications. Aucun benchmark n'a été lancé sous le seuil : le test de capacité arrêté à 2,83 Gio n'a pas chargé de pages. Le runner libère désormais son propre compilateur esbuild avant le test ; aucun build ni autre test simultané pendant les séries finales. Cette différence de runner est explicite et devra être identique des deux côtés dans une comparaison alternée.

Les fixtures 1 Mio sont exactement les mêmes : contenu 1 045 110 octets / 500 blocs ; historique 1 042 470 / 300 blocs, environ 41 000 identifiants clients. Empreintes SHA-256 dans les manifestes. Chaud : 20 chauffes, puis 200 updates ; validation isolée + vraie transaction PostgreSQL + commit de réplique. N'inclut pas réseau, file, projection ni réservation effectuée autour de l'update par `Room`. Froid : 2 chauffes, 30 chargements de salle, admission mémoire, SQL, arbre vivant et réplique neuve ; les processus du pool peuvent être réutilisés. Pas de queue de journal ni de saisie concurrente dans ce benchmark.

- [Référence : synthèse](3d-capacity-2026-10-24/reference/summary.json), [manifeste et RAM](3d-capacity-2026-10-24/reference/manifest.json).
- [Pool initial : synthèse](3d-capacity-2026-10-24/pool-initial/summary.json), [manifeste](3d-capacity-2026-10-24/pool-initial/manifest.json).
- [Candidate : synthèse en échec](3d-capacity-2026-10-24/candidate/summary.json), [manifeste](3d-capacity-2026-10-24/candidate/manifest.json).
- Chaque dossier contient `warm-1` à `warm-3` et `cold-1` à `cold-3`, en JSON avec tous les échantillons et en TXT avec la sortie complète et le code final.

## Fichiers à lire en priorité et preuves

| Sujet        | Fichiers                                                                          | Prouvé par test réel                                                                                                                                                   | Ce qui ne l'est pas                                                                                 |
| ------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Pool partagé | `service/validation-pool.ts`, `incremental-validator.ts`, `incremental-worker.ts` | Quatre salles réparties sur deux workers ; répliques distinctes ; replay de plus de 17 Mio d'updates par messages bornés, contenu inchangé                             | Toutes les saturations possibles de file, véritable OOM, très long journal de changements distincts |
| Reprise      | `service/room.ts`, `server.ts`, `testing/pool.e2e.ts`                             | Terminaison réelle d'un worker ; deux salles fermées/rechargées ; autre worker continue ; update SQL durable avant panne retrouvé ; reconnexion et projection exactes  | Redémarrage de toute la machine, toutes les partitions réseau, reprise à pleine capacité            |
| Réservation  | `service/memory.ts`, `config.ts`, `testing/memory.e2e.ts`                         | Refus explicite, éviction inactive, délai d'inactivité, handshake abandonné ; croissance refusée sans écriture SQL ni changement visible, puis petite écriture réussie | Chaque classe sur toutes les formes admissibles ; plafond RSS strict                                |
| Projection   | `service/projection.ts`                                                           | Projection/compaction automatiques, une réplique temporaire à la fois ; effets audit/outbox et erreurs dans les scénarios existants                                    | Débit à cinquante comptes ; très longs journaux sur petite RAM                                      |
| Capacité     | `testing/capacity.e2e.ts`                                                         | Un essai préparatoire : trente pages connectées par profil, trente écritures confirmées/projetées, aucune connexion perdue                                             | Trois séries de la candidate finale ; cible validée à trente pages ; pile 4 vCPU / 8 Gio            |
| Hygiène      | `scripts/measure-collab.mjs`                                                      | Trois séries, RAM et source enregistrées, empreintes des fixtures, refus de reprise si source modifiée, échecs conservés                                               | Cause matérielle de la dérive, variabilité d'autres machines                                        |

Tous les chemins du tableau sont sous `apps/collab/src/`, sauf le script. Le pool a une limite V8 de 256 + 16 Mio par worker ; la mémoire native et les buffers sont distincts. Une commande hors éditeur réserve temporairement la borne entière et peut être refusée sous pression même si sa modification est petite. PostgreSQL lit encore tout le journal avant le transfert borné au worker. Un déploiement doit redémarrer le service avec son worker compilé correspondant ; ne pas mélanger les deux protocoles.

## Essai préparatoire de trente pages

Trente providers WebSocket réels, deux comptes Better Auth, deux profils de 300 blocs d'environ 173 / 172 Kio, ouverts séparément. Avec quatre workers (8 / 8 / 7 / 7 répliques), réservation totale **976 Mio**. Réplique isolée retenue : 2,15 / 3,38 Mio, facteur Yjs encodé → tas/externe de 12,7 / 20,2. RSS échantillonnée maximale du banc **554 / 731 Mio**, clients et générateur compris. Les mesures de GC servent au diagnostic ; elles ne sont pas activées en production. Pas de mesures à 200 Kio exactement, ni garantie sur toutes les structures sous cette borne.

[Mesures préparatoires](3d-capacity-2026-10-24/capacity-preliminary.json) et [sortie complète](3d-capacity-2026-10-24/capacity-preliminary.txt). Le premier essai avait oublié la synchronisation périodique du front dans les clients de test ; ses connexions silencieuses expiraient. [Échec conservé](3d-capacity-2026-10-24/capacity-missing-keepalive.txt). Le banc reprend ensuite `forceSyncInterval: 15000`, comme le front. Ces résultats précèdent les dernières protections de replay du commit candidat et ne sont pas présentés comme trois séries finales. La règle d'arrêt interdit de poursuivre la qualification de capacité tant que le compromis de performance n'est pas tranché.

## Contrôles et test manuel

`pnpm check` : **92 tests Vitest réussis, 6 tests SQL génériques ignorés**, types de 12 packages et preuve Nest réussis ; [journal complet](3d-capacity-2026-10-24/check.txt). Build collab réussi : [journal](3d-capacity-2026-10-24/build.txt). **13 suites fonctionnelles, 29 tests Node réussis**, PostgreSQL réel : [journal complet](3d-capacity-2026-10-24/functional.txt). Ces réussites ne compensent pas les benchmarks en échec. Pas de nouveau test visuel à deux navigateurs.

1. Redémarrer le service collaboratif compilé avec cette branche ; ouvrir une page dans deux navigateurs connectés au même workspace. Saisir dans les deux et vérifier la confirmation serveur et la convergence.
2. Tester une fermeture/réouverture normale. La page reste en mémoire cinq minutes par défaut ; cela ne doit pas changer le contenu.
3. Lancer `pnpm test:collab:e2e --suite pool` pour la panne ciblée : le test crée ses propres données et termine uniquement son propre worker. Il vérifie la reprise après COMMIT et l'absence de coupure sur l'autre worker.
4. Lancer `pnpm test:collab:e2e --suite memory` pour les refus et l'éviction ; ne pas réduire le budget de l'application avec des modifications en cours.
5. Après décision de reprise, avec ≥3 Gio libres et aucun autre test/build, utiliser `node scripts/measure-collab.mjs --label diagnostic --baseline docs/reviews/3d-capacity-2026-10-24/reference/summary.json`. Pour la capacité : `node scripts/measure-collab.mjs --label capacity --suite capacity`. Les résultats sont créés sous `.local/3d-series/`, jamais écrasés par une relance.

Les commandes SQL utilisent des schémas de test dédiés, nettoyés ensuite. Avant utilisateurs réels : terminer 3d, session 4, finition de l'interface et qualification dédiée **4 vCPU / 8 Gio avec cinquante comptes sur toute la pile**, selon ARCHITECTURE.md. Avant usage prolongé : rebasage automatique uniquement sur page inoccupée.
