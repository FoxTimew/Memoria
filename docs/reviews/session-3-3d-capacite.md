# 3d — pool partagé, mémoire proportionnelle et comparaison alternée

24 octobre 2026. Branche `codex/session-3d-collaboration-capacity`. **Les critères locaux de 3d passent ; livraison prête à relire.** Code applicatif candidat : `875c63f76783e5d28c875bd954d646d8fac31fae`, inchangé pendant le diagnostic. La borne reste 1 Mio ; aucune fusion ni modification des seuils pour faire passer un résultat. La qualification de toute la pile à cinquante comptes reste obligatoire avant les utilisateurs réels.

## Comparaison alternée autorisée : critères de performance respectés

Le développeur a demandé de remesurer référence et candidate en alternance. Les douze séries passent, sans aucun échantillon retiré. Les quatre médianes respectent les plafonds absolus et la marge de régression de 10 %. Cela lève l'arrêt de performance pour poursuivre la preuve de capacité locale ; cela ne qualifie pas encore un serveur de cinquante personnes.

| Mesure à 1 Mio (ms) | Référence : trois p95       | Médiane | Candidate : trois p95       | Médiane |   Écart |
| ------------------- | --------------------------- | ------: | --------------------------- | ------: | ------: |
| Update contenu      | 7,983 ; 7,773 ; 8,397       |   7,983 | 7,765 ; 7,753 ; 7,963       |   7,765 |  −2,7 % |
| Update historique   | 33,253 ; 33,542 ; 34,717    |  33,542 | 33,852 ; 33,068 ; 32,582    |  33,068 |  −1,4 % |
| Froid contenu       | 145,961 ; 147,532 ; 155,473 | 147,532 | 153,824 ; 147,953 ; 150,492 | 150,492 |  +2,0 % |
| Froid historique    | 310,428 ; 322,516 ; 311,962 | 311,962 | 260,669 ; 266,430 ; 246,730 | 260,669 | −16,4 % |

Même en regardant chaque paire individuellement, le plus grand écart positif est +5,39 % (froid contenu, première paire). [Synthèse exacte](3d-alternating-2026-10-24/summary.json), [manifeste](3d-alternating-2026-10-24/manifest.json), [sortie complète, EXIT_CODE=0](3d-alternating-2026-10-24/complete-run.txt). Le dossier contient les douze sorties TXT et les douze JSON, avec tous les échantillons.

`scripts/compare-collab.mjs` extrait deux snapshots Git immuables, référence `665a82986e0dbb7bbcae5e487627089c0f529de7` et candidate `875c63f76783e5d28c875bd954d646d8fac31fae`. Les deux builds sont terminés et esbuild arrêté avant toute mesure. Le test chaud, le test froid, le lecteur des fixtures et l'installation SQL sont communs. Seule la fabrique de validateur diffère, hors des régions chronométrées : worker dédié pour la référence, pool partagé pour la candidate. Les packages et le lockfile doivent être identiques. Les fixtures sont lues sans possibilité de régénération ; SHA-256, sources, protocole et bundles sont consignés. Aucun changement applicatif, réglage d'alimentation, désactivation de durabilité SQL ou build simultané.

Ordre des paires : référence/candidate, candidate/référence, référence/candidate ; chaud puis froid à chaque tour. Un processus Node neuf par série, mêmes 20 chauffes + 200 updates et 2 chauffes + 30 chargements. Douze contrôles RAM avant lancement : **3,761 à 4,007 Gio**, tous ≥3 Gio. Les valeurs individuelles sont dans le manifeste. Windows relève **BatteryStatus=2**, charge 26 à 30 %, pendant toute cette comparaison ; la campagne précédente relevait le code 1. Aucun état d'alimentation n'a été imposé par l'agent.

**Conclusion limitée :** la forte régression de la campagne non alternée n'est pas reproduite lorsque les versions sont rapprochées dans le temps avec le même protocole. Cette ancienne comparaison confondait code et conditions d'exécution. Le changement d'alimentation observé et la dérive temporelle sont des facteurs possibles, pas une cause isolée démontrée. Ces nouvelles valeurs ne sont pas présentées comme une certification sur batterie ni comme une mesure 4 vCPU / 8 Gio.

Une première préparation a échoué à résoudre un import de générateur de fixtures dans le snapshot isolé ; aucun benchmark n'avait démarré. Le lecteur commun utilise désormais exclusivement les deux fichiers déjà hachés. [Échec de build conservé](3d-alternating-2026-10-24/build-preparation-failed.txt). Avant la campagne, un contrôle à 2,10 Gio a entraîné une demande de fermeture d'applications ; reprise après constat de 3,79 Gio. Aucun résultat n'a été filtré.

## Capacité finale : trente pages, trois séries réussies

Même code applicatif que `875c63f` (HEAD de mesure `9366290`, diff applicatif vide). Trois processus indépendants, chacun ouvrant trente pages de contenu puis trente pages historiques ; quatre workers hébergent plusieurs répliques chacun. Deux comptes Better Auth, quinze sockets chacun ; trente modifications, trente confirmations durables et trente projections automatiques par profil. Aucun client déconnecté. Budget par défaut : 1 Gio ; **976 Mio réservés dans chaque série** (720 pour les salles, 128 pour les workers, 128 pour le projecteur).

| Profil (300 blocs) | Taille encodée observée                 | RSS maximale échantillonnée, trois séries (Mio) | Médiane (Mio) | Réplique isolée retenue après GC (Mio/page) |
| ------------------ | --------------------------------------- | ----------------------------------------------- | ------------: | ------------------------------------------- |
| Contenu            | 177 261–177 262 octets, environ 173 Kio | 560,45 ; 562,01 ; 558,73                        |        560,45 | 2,149 ; 2,146 ; 2,148                       |
| Historique         | 175 939–175 986 octets, environ 172 Kio | 749,59 ; 738,34 ; 739,25                        |        739,25 | 3,371 ; 3,367 ; 3,379                       |

Facteurs d'expansion de la réplique isolée : environ 12,7 pour le contenu et 20,1 pour l'historique. La RSS inclut les clients, l'authentification et le générateur de fixtures dans le processus du banc ; ce n'est pas une mesure du serveur seul. Échantillonnage à 25 ms, pics plus courts possibles ; GC forcé pour diagnostic uniquement. Les fixtures de capacité sont régénérées, avec de petites variations d'identifiants et de taille consignées dans chaque JSON ; les deux fixtures de performance à 1 Mio restent strictement identiques.

RAM libre avant les trois lancements : **4,013 / 3,935 / 3,865 Gio** ; contrôle supplémentaire à l'intérieur des tests après compilation : **3,792 / 3,686 / 3,637 Gio**. Tous dépassent 3 Gio. [Synthèse](3d-alternating-2026-10-24/capacity/summary.json), [manifeste](3d-alternating-2026-10-24/capacity/manifest.json), [sortie complète, EXIT_CODE=0](3d-alternating-2026-10-24/capacity/complete-run.txt). Les trois JSON détaillés et sorties individuelles sont dans le même dossier.

La cible locale « au moins trente pages typiques de 200 Kio ou moins avec 1 Gio » est ainsi démontrée pour ces deux profils. Elle ne prouve ni toutes les structures possibles sous 200 Kio, ni la saisie continue de cinquante personnes, ni le comportement après OOM système, ni la pile complète sur quatre vCPU. Les tests fonctionnels antérieurs de reprise PostgreSQL restent applicables au même code et distincts de ce test de capacité.

## Campagne initiale non alternée : arrêt conservé dans l'historique

Cette section décrit la décision antérieure au diagnostic autorisé. Les valeurs et les échecs sont conservés ; l'état actuel est celui de la comparaison alternée ci-dessus.

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

**Option alors recommandée, ensuite autorisée :** comparer référence et candidate en alternance, avec exactement le même runner, les mêmes fixtures et les mêmes relevés de ressources, puis isoler les changements responsables si l'écart persiste. Autre option présentée : revenir au pool initial puis réintroduire les réservations et protections une à une. Le diagnostic ci-dessus répond au choix du développeur ; aucune optimisation applicative supplémentaire n'a été nécessaire.

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

Pour cette dernière révision, commencer par `scripts/compare-collab.mjs` et son manifeste, puis cette fiche et le guide d'hébergement. `vitest.config.mjs` exclut uniquement les copies temporaires `.local/` des tests du dépôt, tout en conservant les exclusions par défaut. Aucun fichier applicatif n'a changé depuis `875c63f`.

| Sujet        | Fichiers                                                                          | Prouvé par test réel                                                                                                                                                   | Ce qui ne l'est pas                                                                                 |
| ------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Pool partagé | `service/validation-pool.ts`, `incremental-validator.ts`, `incremental-worker.ts` | Quatre salles réparties sur deux workers ; répliques distinctes ; replay de plus de 17 Mio d'updates par messages bornés, contenu inchangé                             | Toutes les saturations possibles de file, véritable OOM, très long journal de changements distincts |
| Reprise      | `service/room.ts`, `server.ts`, `testing/pool.e2e.ts`                             | Terminaison réelle d'un worker ; deux salles fermées/rechargées ; autre worker continue ; update SQL durable avant panne retrouvé ; reconnexion et projection exactes  | Redémarrage de toute la machine, toutes les partitions réseau, reprise à pleine capacité            |
| Réservation  | `service/memory.ts`, `config.ts`, `testing/memory.e2e.ts`                         | Refus explicite, éviction inactive, délai d'inactivité, handshake abandonné ; croissance refusée sans écriture SQL ni changement visible, puis petite écriture réussie | Chaque classe sur toutes les formes admissibles ; plafond RSS strict                                |
| Projection   | `service/projection.ts`                                                           | Projection/compaction automatiques, une réplique temporaire à la fois ; effets audit/outbox et erreurs dans les scénarios existants                                    | Débit à cinquante comptes ; très longs journaux sur petite RAM                                      |
| Capacité     | `testing/capacity.e2e.ts`                                                         | Trois séries finales : trente pages connectées par profil, trente écritures confirmées/projetées, aucune connexion perdue ; 976 Mio réservés                           | Toutes les structures sous 200 Kio, frappe continue à cinquante comptes, pile 4 vCPU / 8 Gio        |
| Hygiène      | `scripts/measure-collab.mjs`, `scripts/compare-collab.mjs`                        | Trois paires alternées, même protocole, RAM et sources enregistrées, empreintes des fixtures/bundles, refus de reprise si source modifiée, échecs conservés            | Cause matérielle isolée de la dérive, variabilité d'autres machines                                 |

Tous les chemins du tableau sont sous `apps/collab/src/`, sauf les scripts. Le pool a une limite V8 de 256 + 16 Mio par worker ; la mémoire native et les buffers sont distincts. Une commande hors éditeur réserve temporairement la borne entière et peut être refusée sous pression même si sa modification est petite. PostgreSQL lit encore tout le journal avant le transfert borné au worker. Un déploiement doit redémarrer le service avec son worker compilé correspondant ; ne pas mélanger les deux protocoles.

## Essai préparatoire de trente pages

Trente providers WebSocket réels, deux comptes Better Auth, deux profils de 300 blocs d'environ 173 / 172 Kio, ouverts séparément. Avec quatre workers (8 / 8 / 7 / 7 répliques), réservation totale **976 Mio**. Réplique isolée retenue : 2,15 / 3,38 Mio, facteur Yjs encodé → tas/externe de 12,7 / 20,2. RSS échantillonnée maximale du banc **554 / 731 Mio**, clients et générateur compris. Les mesures de GC servent au diagnostic ; elles ne sont pas activées en production. Pas de mesures à 200 Kio exactement, ni garantie sur toutes les structures sous cette borne.

[Mesures préparatoires](3d-capacity-2026-10-24/capacity-preliminary.json) et [sortie complète](3d-capacity-2026-10-24/capacity-preliminary.txt). Le premier essai avait oublié la synchronisation périodique du front dans les clients de test ; ses connexions silencieuses expiraient. [Échec conservé](3d-capacity-2026-10-24/capacity-missing-keepalive.txt). Le banc reprend ensuite `forceSyncInterval: 15000`, comme le front. Ces résultats précèdent les dernières protections de replay du commit candidat ; les trois séries finales ci-dessus les complètent après levée de l'arrêt de performance.

## Contrôles et test manuel

`pnpm check` final : **92 tests Vitest réussis, 6 tests SQL génériques ignorés**, 19 fichiers réussis / 1 ignoré, types de 12 packages (cache Turbo) et preuve Nest réussis ; [journal complet, EXIT_CODE=0](3d-alternating-2026-10-24/check.txt). Le premier contrôle avait découvert les copies de tests extraites sous `.local/` : 18 copies en erreur de configuration, les 92 tests du dépôt réussis. `vitest.config.mjs` conserve les exclusions par défaut et ajoute seulement `.local/**`, sans modifier ni ignorer les tests applicatifs. [Échec conservé](3d-alternating-2026-10-24/check-generated-copies-failed.txt) ; [passage intermédiaire avec avertissement de format de configuration](3d-alternating-2026-10-24/check-config-native-warning.txt), résolu par l'extension ESM `.mjs`.

Sur le même code applicatif : build collab déjà réussi ([journal](3d-capacity-2026-10-24/build.txt)) et **13 suites fonctionnelles, 29 tests Node réussis**, PostgreSQL réel ([journal complet](3d-capacity-2026-10-24/functional.txt)). Ils ne sont pas présentés comme de nouveaux essais. Cette révision ajoute douze tests Node de performance et trois suites de capacité réussis. Pas de nouveau test visuel à deux navigateurs. Les résultats initiaux en échec restent archivés, même si les critères locaux passent dans le protocole alterné.

1. Redémarrer le service collaboratif compilé avec cette branche ; ouvrir une page dans deux navigateurs connectés au même workspace. Saisir dans les deux et vérifier la confirmation serveur et la convergence.
2. Tester une fermeture/réouverture normale. La page reste en mémoire cinq minutes par défaut ; cela ne doit pas changer le contenu.
3. Lancer `pnpm test:collab:e2e --suite pool` pour la panne ciblée : le test crée ses propres données et termine uniquement son propre worker. Il vérifie la reprise après COMMIT et l'absence de coupure sur l'autre worker.
4. Lancer `pnpm test:collab:e2e --suite memory` pour les refus et l'éviction ; ne pas réduire le budget de l'application avec des modifications en cours.
5. Avec ≥3 Gio libres et aucun autre test/build, utiliser `node scripts/compare-collab.mjs --reference 665a829 --candidate 875c63f`. Les deux fixtures hachées doivent déjà être présentes dans `.local/incremental/` (paquet reproductible préparé). Une campagne crée son dossier sous `.local/3d-alternating/` ; après un arrêt de RAM, reprendre avec `--resume <dossier>` sans changer le protocole. Pour la capacité : `node scripts/measure-collab.mjs --label capacity --suite capacity`. Les résultats sont créés sous `.local/3d-series/`, jamais écrasés par une relance. Ne pas comparer deux campagnes éloignées comme si leurs conditions étaient identiques.

Les commandes SQL utilisent des schémas de test dédiés, nettoyés ensuite. Avant utilisateurs réels : terminer 3d, session 4, finition de l'interface et qualification dédiée **4 vCPU / 8 Gio avec cinquante comptes sur toute la pile**, selon ARCHITECTURE.md. Avant usage prolongé : rebasage automatique uniquement sur page inoccupée.
