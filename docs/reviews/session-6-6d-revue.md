# Session 6d — revue adverse, charge et comparaison finale

27 octobre 2026, branche `codex/session-6-databases`. **Étape non clôturée : partage et promotion à 100 partages passent après les deux optimisations autorisées. Arrêt suivant sur le retrait : attente SQL p95 107,176 ms, plafond 100 ms. Arbre, cycle de vie et comparaison finale restent à qualifier.** Aucun risque n'est accepté ; le développeur crée et fusionne la PR unique.

## Fichiers prioritaires

- `packages/db/drizzle/0021_database_barriers.sql` à `0028_transaction_workspace_barriers.sql` et `packages/db/src/database-cells.ts` : barrières, recontrôle au commit, versions indépendantes, compteurs et liens masqués.
- `apps/api/src/modules/databases/` : autorisations, admission, quotas, schéma, AST paramétrée et curseurs liés au lecteur/requête/schéma/droits.
- `apps/web/src/components/database-screen.tsx`, `database-cell.tsx`, `apps/web/src/lib/yjs-cache.ts` : affichage, saisie conservée sur conflit et cache natif base/ligne.
- `apps/api/src/database-*.e2e.ts`, `scripts/test-databases-browser.mjs`, `apps/api/src/adversarial.e2e.ts` : attaques effectivement exécutables contre les vrais services, y compris depuis l'interface finale.
- `apps/api/src/database-refresh-load.ts`, `database-cell-load.ts`, `database-rights-load.ts`, `scripts/compare-collab.mjs` : mesures et limites de leur interprétation.

## Matrice consolidée des frontières

Les preuves 6a/6b/6c déjà livrées restent dans leurs fiches. Les suites ci-dessous ont été rejouées le 27 octobre contre PostgreSQL, Nest et les transports réels ; les limites indiquées ne sont pas des acceptations.

| ID  | Attaque / invariant                                                                                                                         | Test permanent et surface réelle                                                                                                 | Campagne 6d / limite explicite                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 | Pas de session, session restreinte, MFA/grâce expirée, logout, faux acteur ; aucune nouvelle route publique                                 | `database-table.e2e.ts`, `database-objects.e2e.ts`, `database-services.e2e.ts`, `adversarial.e2e.ts` ; Nest/Better Auth/PG/WSS   | Rejoué avec succès ; les 23 méthodes de bases ont une métadonnée de quota et un refus sans session. Aucune approbation de futures routes.             |
| D02 | Mélanger workspace/base/ligne/propriété/option ; détourner une ancienne route de page ; révéler un parent caché                             | Suites HTTP ci-dessus, noyau `database-cells`, suite `test-shares-browser`                                                       | Rejoué avec succès ; nouvelle tentative depuis le navigateur : même réponse pour ligne inconnue et ligne cachée.                                      |
| D03 | Écrire en guest read ; forger un changement de schéma/options/vue/assignables/archive comme guest edit                                      | `database-objects.e2e.ts`, `database-services.e2e.ts` ; `test-databases-browser` envoie des requêtes malgré l'absence de boutons | Rejoué avec succès ; tentative WSS read-only réellement envoyée au serveur, pas seulement `contenteditable=false`.                                    |
| D04 | Révocation pendant attente, ordre inverse, retrait/réattribution, rôle, facteur, politique ; conserver les accès sans effet                 | Tests PostgreSQL de barrières et équivalence aléatoire, services WSS, tests de partages                                          | Rejoué avec succès ; oracle complet après 500 transactions avec graine et réduction du reproducer. Les pannes de machine entière restent à qualifier. |
| D05 | CAS vide/scalaires/ensembles, même cellule, cellules distinctes, vieux schéma, réponse perdue, Yjs concurrent                               | Noyau 6a, objets/services HTTP, conflit via deux interfaces finales                                                              | Rejoué avec succès ; les cellules ne sont pas des documents CRDT et ne se sauvegardent pas hors ligne.                                                |
| D06 | Deviner une cible relation cachée/archivée/inexistante/autre base ou workspace ; filtre, tri, sélecteur, erreur ; supprimer un lien caché   | Noyau et suites tableau/objets ; tentative de suppression d'ID caché depuis le navigateur final                                  | Rejoué avec succès ; aucun titre/ID/nombre caché. Mention booléenne unique volontaire ; ce n'est pas une absence totale d'information.                |
| D07 | Annuaire par propriété personne, membre hors liste, affectation ancienne, retrait/réinvitation                                              | Noyau, objets HTTP et sélecteur final ; canaris dans réponses et audit                                                           | Rejoué avec succès ; absence de mesure dédiée d'un retrait portant des références personne sur toutes les cellules du workspace.                      |
| D08 | Injection SQL/HTML/URL, AST abusive, curseur falsifié/changé d'acteur, dates/fuseaux/décimaux et options invalides                          | `database-table.e2e.ts`, `database-objects.e2e.ts`, contrats ; HTML inerte et URL javascript rejetée dans le navigateur final    | Rejoué avec succès ; aucune prévisualisation réseau d'URL, donc pas de fetch SSRF introduit par cette interface.                                      |
| D09 | Ancien ticket/cache après downgrade, réattribution, archivage/restauration, logout ; onglet gelé/hors ligne ; interdiction de cache         | `yjs-row-cache.test.ts`, services + Edge, `test-databases-browser` avec vrai gel CDP, politique interdite puis rechargement      | Rejoué avec succès ; le navigateur coupé ne reçoit pas immédiatement la révocation. Les exports antérieurs ne peuvent pas être effacés.               |
| D10 | Création concurrente à la borne, corbeille, reçus rejoués, données invalides initiales, liens masqués au plafond                            | Noyau SQL, objets HTTP et tests de limites atomiques                                                                             | Rejoué avec succès ; hausse des réglages de déploiement subordonnée à une nouvelle mesure.                                                            |
| D11 | Crash pendant agrégation, mutation pendant flush, deux workers, projection retardée, création rejouée                                       | `database-services.e2e.ts` : processus tué pendant transaction, rollback audit/outbox, révisions et recherche                    | Rejoué avec succès ; ne prouve pas une panne simultanée de l'hôte/stockage ni le futur relais de webhooks.                                            |
| D12 | Quotas contournés par IP/Forwarded/IDs/méthodes, saturation admission, NAT légitime ; fuite dans logs/erreurs/audit/outbox/compteurs/emails | Trois suites HTTP, charge 50 comptes, A08 enrichi de canaris de bases et d'une vraie erreur SQL provoquée                        | Rejoué avec succès ; pas de preuve universelle contre les canaux temporels ou la saturation distribuée.                                               |

## Routes et quotas

`W=/api/internal/workspaces/:workspaceId`, `D=W/databases`, `B=D/:databaseId`, `R=B/rows/:rowId`. Les routes ci-dessous passent par le guard global ; Origin est vérifiée pour les mutations. L'identité vient de la session, jamais du corps de requête. Les contrôleurs de bases n'exposent aucun `@Public`.

| Méthode / chemin                                                       | Famille          | Attaques associées                                               |
| ---------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------- |
| `GET D`, `GET B`, `POST B/query`                                       | L                | D01, D02, D06–D08, D12                                           |
| `POST D`, `PATCH B`                                                    | S                | D01–D03, D05, D08, D10, D12                                      |
| `POST B/properties`, `PATCH B/properties/:propertyId`                  | S                | D01–D03, D05, D08, D10, D12                                      |
| `POST B/properties/:propertyId/options`, `PATCH .../options/:optionId` | S                | D01–D03, D05, D08, D10, D12                                      |
| `POST B/rows`, `POST R/archive`, `POST R/restore`                      | C                | D01–D05, D09–D12                                                 |
| `GET R`, `GET R/cells/:propertyId`, `GET B/trash`                      | L                | D01–D03, D05–D09, D12                                            |
| `PATCH R`, `PATCH R/cells/:propertyId`                                 | E                | D01–D08, D10–D12                                                 |
| `POST B/properties/:propertyId/choices`, `GET B/assignable-people`     | L                | D01–D03, D06–D08, D12                                            |
| `PUT B/assignable-people`                                              | A mutate         | D01, D03, D04, D07, D12 ; owner/admin + preuve forte récente     |
| `POST W/row-access`, `POST R/collaboration`                            | L                | D01–D04, D09, D12                                                |
| `PUT R/content`                                                        | Contenu écriture | D01–D04, D09, D11, D12 ; façade HMAC + projection de sa révision |
| `GET W/search` (route étendue)                                         | Contenu lecture  | D01, D02, D06, D07, D11, D12                                     |

L/E/C/S par minute, dans l'ordre IP / compte / workspace : **6 000 / 120 / —**, **6 000 / 120 / 6 000**, **3 000 / 60 / 600**, **300 / 30 / 120**. L est commun aux workspaces du compte, les autres budgets de compte portent sur compte/workspace. Admission des bases : 16 actives, 32 en attente, deux secondes. A mutate : 60/IP/route/minute et 30/compte/workspace/minute. Contenu : 3 600 lectures ou 600 écritures/IP/route/minute ; 120/compte/minute en lecture, 120/compte/workspace/minute en écriture. Le moniteur utilise aussi `/api/auth/security/cache-policy`, 3 600/IP/minute. Aucun de ces budgets n'est relevé par le banc.

## Mesures et contrôles

**Les six séries finales de partage et de promotion passent ; le retrait échoue sur l'attente SQL et arrête la campagne. La comparaison finale n'a pas été lancée.** Les résultats déjà terminés sont détaillés ci-dessous. La première série de dix minutes de rafraîchissement est conservée comme essai incomplet : requêtes réussies et hygiène sans swap, mais absence de télémétrie PostgreSQL à cause des séquences ANSI de Docker Windows. Le collecteur a été corrigé avec un test, puis les trois séries ont été rejouées intégralement. Ce premier essai ne compte pas parmi les trois résultats retenus.

Le banc simule le trafic mesuré sur deux vrais onglets visibles de l'interface finale, puis utilise 50 sessions Better Auth et 50 sockets WSS natives avec présence/synchronisation. Il ne lance pas cent moteurs de rendu. Une ligne persistée par compte, une seule base de 10 000 lignes/50 propriétés, politiques de cache par défaut ; les comptes sont owner/member. Les latences API sont mesurées depuis le middleware avant guard jusqu'à la fin de réponse ; le processus générateur est distinct du processus Nest/collab. Les relevés PostgreSQL portent sur le conteneur complet, qui dessert aussi la pile locale inactive. Ces conditions ne constituent pas la qualification dédiée 4 vCPU/8 Gio.

### Rafraîchissement : trois séries de dix minutes réussies

Chaque série contient **38 000 réponses 200**, soit 760 par compte, aucun 429 et aucun rafraîchissement abandonné. Total : **114 000 réponses**. Les cinquante sockets restent ouvertes. Le trafic calibré est de 76 requêtes/minute/compte, soit 3 800/minute pour le studio : 1 500 contrôles de politique, 1 500 contrôles d'accès aux lignes, 400 lectures de base, 200 requêtes de tableau et 200 lectures de titre par minute. Les cadences de l'application et tous les quotas restent inchangés.

| Indicateur                                       | Série 1 | Série 2 | Série 3 | Lecture                           |
| ------------------------------------------------ | ------: | ------: | ------: | --------------------------------- |
| Tableau, p95 serveur (ms)                        |  60,361 |  62,543 |  61,579 | Médiane 61,579 ; plafond 200      |
| CPU moyen Nest + collab, cœurs                   |   0,391 |   0,390 |   0,387 | Générateur exclu                  |
| RSS maximum Nest + collab (Mio)                  |  510,59 |  524,57 |  528,12 | 50 documents initiaux très petits |
| CPU moyen PostgreSQL, % d'un cœur                |   45,55 |   45,44 |   44,68 | Conteneur entier                  |
| Connexions SQL en attente, maximum échantillonné |      11 |       0 |       0 | Pic transitoire, aucun rejet      |

La réservation des répliques reste à 656 Mio avec le budget par défaut de 1 Gio. Ce résultat ne qualifie ni cinquante corps de 200 Kio, ni cinquante rédacteurs actifs. Secteur confirmé, 602 intervalles vmstat par série, **1 806 intervalles sans swap** ; RAM Windows et MemAvailable WSL conservées avant/après chaque série. Résultats bruts, télémétrie et manifestes SHA256 : [campagne complète](evidence/session-6d-refresh/) ; [essai incomplet conservé](evidence/session-6d-refresh-incomplete/). Code applicatif mesuré : `ea9f23063c85c1021392153e26813ae8746e6973` ; empreinte du bundle de mesure dans le résumé.

### Suite adverse : cadence du test, quotas conservés

Le premier parcours automatisé enchaînait onze navigations/rechargements et leurs éditions en environ quatorze secondes. Il a atteint L = 120 lectures/minute/compte à l'ouverture collaborative : `DATABASE_RATE_LIMITED`, attente annoncée de 47 secondes. L'arrêt et le journal sont conservés. **Décision du développeur du 27 octobre 2026 : cadencer uniquement le test.** Une pause de 65 secondes sépare ses deux phases ; les rafraîchissements réels continuent pendant cette pause. Aucun compteur n'est remis à zéro, aucun 429 n'est réessayé silencieusement, aucun quota ni cadence applicative ne change. Le parcours complet passe ensuite, et sa trace réseau vérifie explicitement l'absence de 429. L'usage normal demandé passe déjà indépendamment dans les trois séries de charge.

### Cellules HTTP pendant l'édition Yjs

Trois séries, deux comptes réels, même ligne : 100 écritures texte, 100 écritures multi-select et 30 paires de modifications concurrentes de la même cellule par série. Les paires donnent exactement un succès et un conflit 409 ; les p95 ci-dessous portent sur les écritures sans conflit. Deux rédacteurs Yjs écrivent chacun cinq fois par seconde, via tickets natifs et WSS/Caddy ; leur confirmation est chronométrée à l'arrivée du reçu durable. Guards, admission, quotas, sérialisation et agrégation réelle des événements sont actifs.

| p95 (ms)                       | Série 1 | Série 2 | Série 3 | Médiane / plafond |
| ------------------------------ | ------: | ------: | ------: | ----------------- |
| Cellule texte, serveur HTTP    |  37,533 |  35,094 |  37,703 | 37,533 / 100      |
| Cellule ensemble, serveur HTTP |  42,457 |  42,656 |  43,927 | 42,656 / 100      |
| Confirmation reçue en WSS      |  21,896 |  21,104 |  21,023 | 21,104 / 200      |

836, 840 et 838 reçus WSS ; convergence finale vérifiée. Secteur, mémoire et zéro swap passent les trois séries. Cette fixture vise la contention sur une ligne et n'est pas le tableau rempli ni le workspace de 50 000 lignes.

Résultats et hygiène : [cellules HTTP](evidence/session-6d-cells/).

### Droits HTTP à 50 000 lignes : arrêt avant optimisation

La fixture contient 1 000 pages ordinaires, 50 bases, 50 000 lignes, 100 memberships, 5 000 partages et une profondeur de 50. Les propriétés sont vides : cette mesure vise la cardinalité des droits, pas une base remplie de valeurs. Cinq éditeurs natifs écrivent chacun cinq fois par seconde dans quatre lignes de bases distinctes et une page ordinaire. L'owner qui change le partage a une preuve WebAuthn récente réelle. Les mutations HTTP sont espacées de 2,15 secondes pour respecter les quotas ; aucun compteur n'est neutralisé. Préparatifs et lecture de la version de précondition sont hors fenêtre d'écriture mesurée.

La **première série seulement** est exécutée : 32 changements de partage dont deux échauffements explicites, 30 retenus, 530 reçus WSS dont 180 chevauchent temporellement la mutation, et 150 attentes SQL observées. Aucune médiane de trois séries n'est disponible : le banc s'arrête au premier dépassement.

| Mesure p95                                     | Résultat (ms) | Plafond (ms) |
| ---------------------------------------------- | ------------: | -----------: |
| Mutation HTTP, serveur                         |       298,728 |         <500 |
| Attente SQL observée chez les éditeurs bloqués |   **192,099** |     **<100** |
| Confirmation reçue en WSS, tous les reçus      |   **211,316** |     **<200** |
| Confirmation WSS chevauchant la mutation       |   **245,857** |     **<200** |
| Confirmation côté service                      |       188,157 |   Indicateur |

Attente SQL échantillonnée toutes les 5 ms : approximation, distribution des attentes effectivement observées, sans ajouter des zéros aux écritures non bloquées. Le chevauchement temporel ne prouve pas à lui seul la causalité de chaque latence. Aucune déconnexion ni erreur HTTP, 31 fenêtres d'événements agrégées. Secteur confirmé, Windows 3,88 → 3,42 Gio disponibles, WSL 5,33 → 5,26 Gio, 72 intervalles sans swap. [Échantillons et journal de l'arrêt](evidence/session-6d-rights-before/).

Diagnostic statique avant profilage : `SharesService.change` appelle `requireSensitiveAction`, qui prend les barrières exclusives des bases et les verrous des pages ordinaires. Ensuite, un `SELECT` sans filtre `kind` charge **les 51 000 pages**, puis `shareState` charge **les 5 000 grants** et tous les guests pour modifier un seul partage. Les triggers de réconciliation ciblée existent déjà ; ce constat ne permet pas encore d'attribuer précisément les millisecondes aux transferts, à Drizzle ou aux triggers. Il ne faut pas extrapoler les mesures SQL directes de 6a au chemin HTTP complet.

Décision du développeur, 27 octobre : **profiler puis réduire le travail sous barrière**, en conservant tous les contrôles de session, facteur, politique, accès, précondition et commit. Piste : limiter la validation de page à l'arbre ordinaire/aux ancêtres requis et remplacer les listes intégrales par les lectures ciblées et compteurs nécessaires. Aucun calcul ne sera déplacé hors verrou sans précondition et revalidation atomique. Pas de relèvement de plafond. Le rôle, retrait, déplacement, archivage/restauration et la comparaison alternée restent à mesurer ensuite.

Les premières mises au point du banc sont conservées séparément : délai de préparation de la grosse fixture passé au même 120 s que 6a (le délai de 10 s coupait la transaction de peuplement), puis contrat de ticket de page ordinaire corrigé (HTTP 201, portée `page`). Elles ont échoué avant toute série et ne sont ni des mesures ni des corrections applicatives.

### Profilage et correction autorisée du partage

Le diagnostic initial a été poussé et vérifié sur le distant à `cf91429f9b0bcf03553b311f5f03753efa08d3e5`. Ensuite, trois séries de six mutations HTTP réelles ont été profilées, sans rédacteurs concurrents, sous le même protocole d'hygiène. Une tentative interrompue avant enregistrement complet est conservée séparément. Les latences instrumentées ne sont pas des échantillons de qualification : le profileur force la contrainte différée juste avant COMMIT pour isoler la réconciliation, relève `pg_stat_xact_user_functions` et exécute EXPLAIN ANALYZE sur les SELECT capturés. Aucun paramètre d'authentification n'est écrit dans les traces.

| Étape, moyenne par série (ms)                               | Série 1 | Série 2 | Série 3 |
| ----------------------------------------------------------- | ------: | ------: | ------: |
| Lecture/transfert/décodage des 51 000 pages, côté client PG |  89,212 |  90,874 |  87,646 |
| Entre fin de cette requête et début de la suivante          |  94,036 |  96,434 |  90,692 |
| Lecture des 5 000 partages                                  |   7,209 |   7,992 |   7,319 |
| Acquisition initiale des barrières                          |   5,521 |   5,981 |   5,225 |
| Réconciliation différée isolée                              |  18,764 |  18,912 |  17,852 |

Les trois plans de pages sont des parcours séquentiels de **51 000 lignes**, environ **9 ms côté PostgreSQL**, 732 blocs en cache ; les plans de grants trient **5 000 lignes** en 3,25–3,56 ms. Le temps entre requêtes comprend notamment la conversion Drizzle et la validation de page, sans attribution exclusive à une fonction JavaScript. Les fonctions montrent une seule réconciliation et cinq appels de barrière par mutation (appel initial et triggers) ; leurs temps inclusifs ne s'additionnent pas aux requêtes qui les contiennent. Les trois p95 diagnostiques par étape et les plans/statistiques complets sont dans [le profilage](evidence/session-6d-share-profile/).

Correction applicative retenue : filtrer `kind='page'` dans les deux lectures de l'arbre par `SharesService` (consultation et mutation), comme le service d'arborescence le faisait déjà. Les lignes héritent de leur base et ne participent pas aux chemins de pages ordinaires. Le transfert passe donc de 51 000 à au plus 1 000 enregistrements sur cette fixture. **Aucun contrôle, verrou, trigger ou précondition n'est déplacé ou retiré ; aucun calcul hors transaction.** Les 5 000 partages restent lus pour l'instant : leur coût mesuré est secondaire et ne justifie pas de remanier simultanément ce parcours avant requalification.

Tests après correction : suite objets HTTP **9 réussis**, dont refus de consultation et mutation d'un partage individuel de ligne, avec partage de la base toujours fonctionnel ; suite partages HTTP/WS **7 réussis**, héritage, previews, révocation ciblée et quotas compris. Le nouveau test intervient après les scénarios qui exigent volontairement un owner sans preuve récente ; son premier placement avant eux avait modifié leur fixture d'assurance, puis a été corrigé sans changer leurs assertions. `pnpm check` termine encore avec 166 réussis, six SQL ignorés ; journaux complets `objects-after-sharing.txt`, `shares-after.txt` et `check-sharing.txt`.

### Requalification après correction : partage réussi, arrêt sur la promotion

Candidate applicative `8fc39f4717029d5b8a950e2c11f1ca68226bfdaf`. Même protocole HTTP/WSS non instrumenté et fixture aux mêmes cardinalités ; trois séries de partage terminées, puis une seule de rôle. Les identifiants de fixture sont régénérés : ne pas présenter cette campagne comme une comparaison alternée ou apparier artificiellement ses mutations à celles de la campagne précédente. Tous les échantillons, les traces mémoire et l'arrêt sont dans [la campagne après correction](evidence/session-6d-rights-after-sharing/).

| Partage, p95 (ms)                | Série 1 | Série 2 | Série 3 | Médiane / plafond  |
| -------------------------------- | ------: | ------: | ------: | ------------------ |
| Mutation HTTP                    |  95,813 |  90,040 |  91,888 | 91,888 / 500       |
| Attente SQL observée             |  33,415 |  37,697 |  38,249 | 37,697 / 100       |
| Reçu WSS, tous                   |  48,356 |  48,701 |  48,986 | 48,701 / 200       |
| Reçu WSS chevauchant la mutation |  61,422 |  57,894 |  62,229 | 61,422 / 200       |
| Confirmation service             |  43,918 |  44,635 |  44,169 | 44,169, indicateur |

Le scénario suivant promeut un **guest possédant 100 partages** en member par la vraie route HTTP, puis restaure la fixture hors fenêtre mesurée. Les 100 anciens partages sont supprimés conformément à la règle produit. Sa première série de 30 mutations retenues échoue : **HTTP 578,207 ms (>500)**, **attente SQL 466,891 ms (>100)**, **reçu WSS total 463,443 ms et chevauchant 496,648 ms (>200)**, confirmation service 459,174 ms. 621 reçus, 180 chevauchants, 150 attentes observées ; aucune erreur HTTP ni déconnexion. Les quatre séries ont chacune 71 intervalles sans swap, secteur confirmé ; mémoire Windows toujours au-dessus de 3,4 Gio et WSL au-dessus de 5,2 Gio avant/après.

La preuve de rôle 6a visait un membership initialement member sans ces cent partages : ses chiffres ne couvrent pas ce cas. Le développeur a autorisé le profilage des triggers, puis la réduction des acquisitions répétées dans une même transaction. Retrait, arbre, cycle de vie et comparaison alternée restent à qualifier.

### Profilage de la promotion et réutilisation des barrières — 27 octobre 2026

[Trois séries de diagnostic](evidence/session-6d-role-profile/), six promotions HTTP réelles chacune, même fixture pleine et aucun rédacteur concurrent. Instrumentation identique au partage : temps client PostgreSQL, `track_functions=all`, réconciliation différée explicitement déclenchée avant COMMIT, EXPLAIN ANALYZE de la requête native capturée dans une transaction annulée. Ces temps instrumentés ne remplacent pas la qualification HTTP/WSS.

| Moyenne par série (ms)                |       1 |       2 |       3 |
| ------------------------------------- | ------: | ------: | ------: |
| HTTP instrumenté                      | 558,609 | 529,869 | 488,565 |
| UPDATE du membership, triggers inclus | 460,386 | 443,746 | 411,382 |
| Réconciliation différée               |  48,195 |  44,504 |  36,501 |

Chaque promotion appelle `database_lock_workspace` **103 fois**. Les plans trouvent le membre en 0,013–0,020 ms (100 memberships, trois blocs en cache) ; le trigger `content_clear_promoted_grants` prend 433,383 / 508,077 / 381,299 ms. Les temps inclusifs de fonctions s'emboîtent et ne s'additionnent pas. Ce diagnostic a été présenté avant la correction.

Migration `0028_transaction_workspace_barriers.sql` : marqueur temporaire PostgreSQL, par relation de base et workspace, inséré **après** acquisition de tous les verrous existants, `ON COMMIT DELETE ROWS`. Les appels suivants de la même transaction réutilisent les verrous détenus. Une annulation de transaction ou un retour au savepoint annule aussi le marqueur ; aucune mémoire JavaScript ni GUC persistant. Aucun contrôle de session, politique, droits, version ou réconciliation n'est mémorisé ou supprimé. La suppression des anciens partages lors d'une promotion est conservée. Les créations de pages ordinaires et de bases restent sérialisées par le mutex du workspace. Le rôle SQL serveur doit pouvoir créer une table temporaire ; cette table est interne au backend, pas une API client.

Test permanent `database-lock-reuse.e2e.ts` : huit sous-scénarios réels, neuf résultats node:test parent compris. Attente de vraies écritures après 103 appels, reprise après COMMIT/ROLLBACK, savepoint annulant l'acquisition, savepoint conservant une acquisition extérieure, timeout partiel, deux workspaces, création initiale de la table temporaire annulée puis rejouée, base/page créées après acquisition. La contention est observée dans `pg_stat_activity` et `pg_blocking_pids`, pas supposée après un délai. Le premier essai a corrigé un paramètre UUID/texte de fixture avant toute assertion ; son journal est conservé. L'oracle aléatoire passe encore 500 transactions et 1 015 opérations avec la même graine. La requalification des plafonds reste requise.

### Contrôles fonctionnels rejoués

- `pnpm check` : 30 fichiers de tests réussis, un fichier SQL ignoré ; **166 tests réussis et six SQL ignorés** dans cette commande. Les six SQL passent séparément.
- Suites HTTP tableau/objets/services : résumés node:test de **7 / 8 / 10 tests**, sous-tests et parents compris. Noyau SQL de cellules : **19 tests**. Barrières : assertions de l'héritage, anciennes routes fermées et deux ordres de commit réussies.
- Équivalence ciblé/complet : **500 transactions, 1 015 opérations**, graine **1780491792** ; deux tests réussis, dont le réducteur du reproducer. Rôles, sujets, grants, déplacements, archives, restaurations, retraits et transactions annulées inclus.
- Suite adverse d'authentification enrichie : **9 tests**, dont canaris de bases et erreur SQL réellement déclenchée. Recherche de fuites : **184 erreurs, 97 entrées de journal applicatif, huit emails et trente canaris**, plus audit/outbox/compteurs. Les logs PostgreSQL de diagnostic peuvent reprendre les erreurs SQL injectées : cette preuve ne signifie pas que tous les logs d'infrastructure sont expurgés.
- Interface finale : **un scénario intégré** (les messages PASS intermédiaires ne sont pas des tests distincts), 90,94 s dont 65 s de cadence. Tentatives d'écriture read-only et schéma guest, ID de ligne cachée comparé à un ID inconnu, retrait de relation masquée, URL dangereuse, HTML inerte, CAS, WSS, cache hors ligne/figé, interdiction puis réautorisation du cache et logout. Le scénario intégré des pages ordinaires passe aussi.

Les [journaux complets](evidence/session-6d-functional/) distinguent les échecs de cadence de la relance réussie. Les canaris visent les réponses, erreurs, journaux applicatifs, métadonnées d'audit/outbox et compteurs. Ils ne rendent pas publics les corps de lignes, les tokens ou les cookies dans les preuves versionnées. Les canaux fonctionnels d'enrôlement/récupération gardent les seules exceptions déjà approuvées en session 4.

## Risques résiduels — recommandations, aucune acceptation

| ID     | Risque / absence de preuve                                                                                                                                         | Recommandation                                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S6-R01 | Le rafraîchissement dépend du nombre d'onglets visibles, de workspaces et de lignes déjà cachées ; le scénario demandé ne couvre qu'une ligne persistée par compte | Publier la charge exacte ; qualifier l'accumulation des caches et les usages multi-workspaces avant utilisation prolongée. Toute saturation mesurée exige un arbitrage de cadence, regroupement ou quotas. |
| S6-R02 | Mesures sur portable, pas sur l'hôte cible ; cinquante sockets au repos ne représentent pas cinquante rédacteurs et une recherche soutenue                         | Maintenir la qualification 4 vCPU/8 Gio avec charge mixte de 50 comptes avant utilisateurs réels.                                                                                                          |
| S6-R03 | Cache hors ligne, onglet figé, exports et copies déjà détenus ne sont pas effaçables à distance                                                                    | Conserver les contrôles avant reprise, tombstones et options poste partagé/politique ; expliquer cette limite à l'exploitant.                                                                              |
| S6-R04 | Pagination sans instantané : modification d'une clé de tri pendant la navigation peut déplacer une ligne entre pages                                               | Garder la sémantique documentée et proposer un rafraîchissement ; ne pas la présenter comme export exhaustif stable.                                                                                       |
| S6-R05 | Saisie relationnelle non confirmée conservée seulement dans l'onglet, contrairement au corps Yjs                                                                   | Garder la distinction explicite dans l'interface et le guide ; qualifier l'avertissement de départ dans la finition avant utilisateurs.                                                                    |
| S6-R06 | Crash testé sur processus d'agrégation, pas panne complète hôte/disque ; projection/worker indisponibles retardent recherche du corps et événements                | Reprendre les essais de crash/sauvegarde/restauration en qualification et surveiller l'ancienneté des fenêtres/projections.                                                                                |
| S6-R07 | Historique Yjs disproportionné et ancienne information présente dans un document déjà reçu                                                                         | Maintenir le rebasage inoccupé obligatoire avant usage prolongé et le plafond 1 Mio ; ne pas promettre l'effacement des copies antérieures.                                                                |
| S6-R08 | Les canaris ne démontrent pas l'absence universelle de fuite, ni une résistance aux sondes temporelles distribuées                                                 | Conserver R12/S5-R11 comme règles permanentes ; rejouer les attaques pour toute nouvelle route ou source de référence.                                                                                     |
| S6-R09 | Rétention/purge/anonymisation générale et livraison de webhooks restent hors session 6                                                                             | Maintenir R13 avant utilisateurs réels ; vérifier alors les nouvelles tables, reçus, références personne, événements et audits.                                                                            |
| S6-R10 | Retrait d'une personne référencée massivement et valeurs aux bornes sur toutes les lignes non qualifiés par la seule fixture de droits                             | Ajouter ce profil à la qualification, sans extrapoler les mesures de pages/lignes vides.                                                                                                                   |
| S6-R11 | Risques antérieurs de saturation globale, huit réservations mot de passe et ingénierie sociale opérateur                                                           | Conserver les décisions datées de session 4 et les prérequis SaaS ; cette session ne constitue pas une nouvelle acceptation.                                                                               |
| S6-R12 | Restauration de colonnes absente de l'interface, finition visuelle et messages encore techniques                                                                   | Ajouter le panneau dans la finition avant utilisateurs ; restauration d'options/lignes et route de propriété restent distinctes.                                                                           |
| S6-R13 | Onze navigations automatiques en quatorze secondes atteignent L malgré la réussite de la charge nominale ; cadencer le test ne relève pas cette limite utilisateur | Conserver les quotas conformément à la décision ; qualifier les parcours rapides et l'accumulation de caches avant toute modification de cadence ou quota.                                                 |
| S6-R14 | Partage et promotion requalifiés ; retrait HTTP d'un guest à 100 partages à 107,176 ms d'attente SQL (>100), arbre/cycle de vie et comparaison encore absents      | Bloquer la clôture 6d et le merge. Recommander un profilage du retrait après arbitrage ; aucune nouvelle optimisation ni dérogation sans décision.                                                         |

## Relecture manuelle

Suivre le [guide consolidé à deux navigateurs](session-6-guide-manuel.md), notamment le prestataire qui met à jour le statut, les liens cachés conservés, le conflit explicite et le retrait/rétablissement avec un onglet hors ligne. Ce qui peut casser : ordre des verrous, époque base/ligne confondue avec la version d'une cellule, contrôle de droits oublié dans une projection ou un sélecteur, et trafic automatique sous-estimé. Les résultats finaux doivent être renseignés avant de présenter cette étape comme terminée.

### Requalification de 0028 : partage et promotion

Version applicative `575f10321d12d8bb0da16a4292e901e8c75e175a`, six séries conformes archivées dans [la campagne partage/rôle](evidence/session-6d-rights-share-role-final/). Le partage vise désormais une base racine : assertion du changement effectif lecture/édition, sans droit hérité qui le masque. Cette sélection plus précise interdit de présenter les campagnes précédentes comme des paires alternées.

| P95 (ms), séries 1 / 2 / 3  | Partage                  | Promotion guest avec 100 partages |
| --------------------------- | ------------------------ | --------------------------------- |
| HTTP                        | 76,651 / 71,813 / 72,620 | 108,937 / 91,491 / 96,099         |
| Attente SQL observée        | 15,403 / 17,894 / 23,612 | 50,547 / 40,793 / 45,950          |
| WSS chevauchant la mutation | 45,314 / 40,848 / 42,947 | 72,114 / 60,061 / 64,997          |

Médianes respectives : **72,620 / 17,894 / 42,947 ms** et **96,099 / 45,950 / 64,997 ms**, sous 500/100/200. Aucun seuil ni contrôle modifié. La première remise en état après retrait échoue ensuite dans la fixture : elle tente de recréer le même UUID de membership, alors que la référence personne détachée doit rester conservée en production. Erreur et trace sont archivées ; cette série incomplète ne compte pas.

Correction du banc seulement (`786b39bf201468ccf263e123409770a55f090082`) : sa fixture isolée efface sa seule référence personne détachée et sans affectation avant de recréer son UUID de test, hors fenêtre mesurée. Un vrai retour dans le workspace reçoit un nouveau membership et une nouvelle référence personne ; le trigger de production ne change pas. Reprise explicite `--from-case remove`, avec nouvelle préparation, trois séries par cas et mêmes plafonds ; aucune série antérieure supprimée ou amalgamée.

### Nouvel arrêt : retrait à 100 partages

Version applicative identique à `575f103`, banc corrigé `786b39b`. [Série complète et hygiène](evidence/session-6d-rights-remove-stop/) : 30 mutations après deux warmups, 93 attentes observées, 456 reçus WSS dont 140 chevauchant la mutation, 129 événements agrégés. **P95 HTTP 190,166 ms (<500), attente SQL 107,176 ms (>100), WSS total 112,508 ms et chevauchant 129,860 ms (<200)**. Confirmation service 108,207 ms, indicateur. Une seule série, aucune médiane de trois annoncée. Secteur confirmé ; 71 intervalles vmstat sans swap, Windows 3,687 → 3,685 Gio, WSL 5,331 → 5,310 Gio.

Arrêt automatique au premier plafond dépassé. Aucun nouvel essai ni modification de production après ce résultat. Une lecture du code suggère une piste à confirmer : lors de la suppression en cascade du sujet, les triggers des grants peuvent ne plus retrouver le membre et élargir la réconciliation à tout le workspace (`content_queue_access`, migration 0024). Ce n'est pas un coût mesuré ni un diagnostic établi. Recommandation : profiler le retrait (plans, triggers et réconciliation) avant toute correction ciblée, puis conserver les preuves d'équivalence et de rollback. Autre option soumise au développeur : autoriser les deux séries restantes sur cette version inchangée pour évaluer la reproductibilité du dépassement de 7,176 ms ; cela ne constitue pas une dérogation au plafond.

Restent non exécutés sur cette candidate : les séries de déplacement, archivage/restauration ordinaires et de ligne, puis la comparaison alternée avec main. Le navigateur final a été attaqué avant 0028 ; après 0028 les suites réelles cellules, barrières, partages HTTP/WSS, objets et équivalence aléatoire passent, mais le scénario Edge complet n'a pas encore été rejoué. La PR reste un brouillon non prêt au merge.

Contrôle final de cette livraison : `pnpm check` terminé, **166 réussis / six SQL ignorés**, puis `pnpm test:db` terminé, **six réussis** sur les migrations actuelles. Journaux complets `evidence/session-6d-functional/acquisitions-final-check.txt` et `acquisitions-db.txt`. Les tests de verrous, cellules, objets HTTP, partages HTTP/WSS et oracle aléatoire après 0028 sont archivés avec le préfixe `lock-` ; aucun test ignoré n'est présenté comme exécuté par `pnpm check`.

### Profilage puis correction du retrait — 27 octobre 2026

Autorisation explicite du développeur après l'arrêt à 107,176 ms. [Trois séries de profilage](evidence/session-6d-remove-profile/), six retraits HTTP chacune, même fixture 1 000 pages / 50 000 lignes / 100 memberships / 5 000 grants. Session propriétaire et contrôle d'assurance réels ; aucun rédacteur pendant le diagnostic. Mesures instrumentées, séparées de la qualification WSS.

| Moyenne par série (ms)                        |       1 |       2 |       3 |
| --------------------------------------------- | ------: | ------: | ------: |
| HTTP instrumenté                              | 200,196 | 143,209 | 144,379 |
| DELETE du membre, triggers compris            |  11,079 |   8,170 |   8,180 |
| Réconciliation au commit                      | 137,139 |  92,577 |  93,112 |
| Fonction de barrière, appels inclusifs        |   8,496 |   7,821 |   7,298 |
| Enregistrement de la portée, appels inclusifs |   4,274 |   2,663 |   2,705 |

Les coûts inclusifs s'emboîtent : ne pas les additionner. Les dix-huit traces ont `all_members=true, all_pages=true`. Le DELETE dans les plans prend 6,620 / 3,959 / 11,478 ms. Le calcul des effets de la portée réellement enregistrée prend 115,678 / 119,808 / 119,127 ms : **55 900 décisions avant et après pour les 99 memberships restants, zéro différence retournée**, 640 blocs temporaires écrits (ce n'est pas du swap Linux). La portée est élargie par les grants dont le sujet vient de disparaître, alors que le trigger du sujet conserve OLD.member_id. Diagnostic présenté avant optimisation.

Migration 0029 : le grant supprimé par la cascade laisse son sujet enregistrer la portée ; le sujet disparu dispose de OLD.kind/OLD.member_id. Pas de suppression des verrous, des notifications ni du recontrôle au commit. La FK non différable et sa cascade sont vérifiées explicitement. Dix sous-scénarios réels (`reconciliation-cascade`, onze résultats node:test parent compris) couvrent suppression directe, sujet à cent partages, retrait de membre, cascades multiples, réaffectation puis cascade, portée globale conservée, savepoint, contraintes déclenchées immédiatement, sujet API key conservant le secours global, attente réelle du rédacteur suivie de refus après commit ou autorisation après rollback. Chaque scénario compare aussi au calcul complet. Requalification de performance requise avant toute clôture.
