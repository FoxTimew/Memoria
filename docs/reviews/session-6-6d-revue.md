# Session 6d — revue adverse, charge et comparaison finale

Campagne des 27–28 octobre 2026, branche `codex/session-6-databases`. **6d terminée pour relecture : 24 séries de mutations passent sur la correction finale, ainsi que les douze suites de comparaison alternée et le parcours adverse de l'interface reconstruite.** Le contrôle du leadership reste conservé au commit, après les attentes de barrières. Aucun risque résiduel n'est accepté ; le développeur décide des risques, crée et fusionne la PR unique.

## Dernière qualification : arborescence et lignes

Code applicatif `fb8fb713d2ac2ec9f08e43d1ff462af497a7b31b`, même fixture de 1 000 pages ordinaires, 50 000 lignes, 100 memberships et 5 000 partages. Les opérations ordinaires touchent un sous-arbre de 40 pages. Cinq documents natifs WSS écrivent pendant chaque mutation HTTP ; les autres pages restent ouvertes. Trois séries par opération, 30 mutations retenues après deux échauffements. [Échantillons, quinze relevés sans swap et journal complet](evidence/session-6d-rights-tree-final/).

| Opération              | HTTP p95, séries 1 / 2 / 3 (ms) | Médiane HTTP | Attente SQL p95, séries 1 / 2 / 3 (ms) | Médiane SQL | Reçu WSS chevauchant p95, séries 1 / 2 / 3 (ms) | Médiane WSS |
| ---------------------- | ------------------------------- | -----------: | -------------------------------------- | ----------: | ----------------------------------------------- | ----------: |
| Déplacement            | 126,454 / 132,468 / 126,578     |      126,578 | 72,904 / 67,911 / 68,862               |      68,862 | 98,308 / 97,524 / 95,288                        |      97,524 |
| Archivage ordinaire    | 152,178 / 151,007 / 139,008     |      151,007 | 94,495 / 80,689 / 79,022               |      80,689 | 118,321 / 101,243 / 94,490                      |     101,243 |
| Restauration ordinaire | 129,881 / 123,553 / 126,049     |      126,049 | 66,707 / 61,885 / 60,491               |      61,885 | 88,139 / 86,517 / 84,856                        |      86,517 |
| Archivage de ligne     | 23,752 / 23,884 / 24,015        |       23,884 | 0 / 0 / 0                              |           0 | 14,621 / 16,189 / 17,260                        |      16,189 |
| Restauration de ligne  | 24,817 / 25,985 / 26,812        |       25,985 | 0 / 0 / 0                              |           0 | 16,915 / 17,892 / 15,669                        |      16,915 |

Plafonds respectés dans chaque série : HTTP <500 ms, attente SQL <100 ms et reçu WSS <200 ms. Les p95 de tous les reçus, distincts de ceux qui chevauchent une mutation, passent aussi et restent dans les fichiers bruts. La sonde SQL observe toutes les 5 ms : zéro indique qu'aucune attente mesurable n'a été retenue, pas une preuve d'absence absolue de contention. Batterie en état 2, Windows/WSL au-dessus des réserves requises et 1 065 intervalles vmstat sans swap. Les contrôles de session, facteur, politique, versions, réconciliation, audit et outbox restent actifs. Les chiffres initiaux de diagnostic ne sont pas une comparaison alternée ; la forte diminution confirme seulement ce chemin sur cette fixture.

Les tests de contention conservent une barrière pendant 3,3 secondes : ouverture, journalisation et projection attendent sans bloquer le renouvellement du leader. Une terminaison réelle du backend leader pendant l'attente ferme les sockets et laisse la révision inchangée. Ces tests portent sur les attentes de barrières et de mutex ; ils ne prouvent pas qu'une transaction arbitrairement lente après acquisition du fence serait sans effet sur le renouvellement.

## Confirmation finale des mutations d'accès

Confirmation partage/rôle/retrait sur le même code applicatif `fb8fb71` : [neuf séries complètes](evidence/session-6d-rights-access-final/). Le sélecteur de banc `--through-case remove` évite de répéter les quinze séries d'arbre terminées, sans changer les mesures ni supprimer de série. Les neuf relevés secteur/mémoire passent et les 639 intervalles vmstat n'ont aucun swap. Toutes les réponses attendues et les reçus durables sont vérifiés, avec agrégation des événements active.

| Opération                         | HTTP p95, séries 1 / 2 / 3 (ms) | Médiane HTTP | Attente SQL p95, séries 1 / 2 / 3 (ms) | Médiane SQL | Reçu WSS chevauchant p95, séries 1 / 2 / 3 (ms) | Médiane WSS |
| --------------------------------- | ------------------------------- | -----------: | -------------------------------------- | ----------: | ----------------------------------------------- | ----------: |
| Partage effectif lecture/édition  | 77,301 / 76,275 / 78,514        |       77,301 | 19,275 / 18,404 / 26,015               |      19,275 | 44,153 / 44,074 / 48,398                        |      44,153 |
| Promotion guest avec 100 partages | 100,794 / 99,558 / 91,128       |       99,558 | 45,331 / 49,480 / 41,786               |      45,331 | 68,357 / 62,716 / 63,137                        |      63,137 |
| Retrait guest avec 100 partages   | 52,983 / 54,999 / 56,358        |       54,999 | 0 / 7,357 / 12,982                     |       7,357 | 29,969 / 28,343 / 30,857                        |      29,969 |

Les huit mutations passent donc leurs 24 séries sur la correction finale ; les preuves plus anciennes sont conservées comme historique. Ce résultat ne remplace pas la comparaison alternée des mises à jour et chargements de documents de 1 Mio.

## Comparaison alternée finale avec main

Main figé `4d611edfe7ae7e00bad1be3d9327e9e2acf2e55c`, candidate applicative `fb8fb713d2ac2ec9f08e43d1ff462af497a7b31b`. Même banc, dépendances et profils encodés ; sources, packages et migrations propres à chaque commit. Session forte, politique obligatoire et époque par page actives dans les deux versions. Ordre AB / BA / AB, trois paires, aucun build ni test concurrent. [Manifeste, résultats et échantillons](evidence/session-6d-performance/summary.json), [journal complet](evidence/session-6d-performance/complete.txt). Les douze suites réussissent et tous les relevés d'hygiène sont conformes.

| Mesure p95 (ms)         | Main, trois séries          | Candidate, trois séries     | Médianes main → candidate |   Écart | Marge permise |
| ----------------------- | --------------------------- | --------------------------- | ------------------------- | ------: | ------------: |
| Update contenu 1 Mio    | 9,444 / 10,410 / 8,893      | 9,188 / 11,654 / 10,558     | 9,444 → 10,558            |  +1,114 |         2,000 |
| Update historique 1 Mio | 37,333 / 36,866 / 35,175    | 39,786 / 37,642 / 34,553    | 36,866 → 37,642           |  +0,777 |         3,687 |
| Froid contenu 1 Mio     | 163,896 / 151,732 / 149,746 | 150,020 / 178,334 / 151,486 | 151,732 → 151,486         |  −0,246 |        15,173 |
| Froid historique 1 Mio  | 272,104 / 272,033 / 269,832 | 246,766 / 294,535 / 255,375 | 272,033 → 255,375         | −16,658 |        27,203 |

Plafonds absolus respectés dans les douze suites : contenu <50 ms, historique ≤100 ms, froid <500 ms. La règle porte sur les médianes des p95 : marge max(10 %, 2 ms). Ainsi +11,8 % sur l'update contenu reste autorisé car l'écart vaut 1,114 ms ; la deuxième paire froide varie davantage, sans être retirée. Aucun échantillon ni série écarté. Ce résultat ne démontre pas une cause unique à cette variabilité ni les performances sur le futur hôte dédié.

Warm mesure validation incrémentale, journal transactionnel réel et commit de réplique, hors socket/file/projection. Froid mesure l'admission et le chargement du document et de sa réplique ; cette comparaison n'est pas un test WSS sous contention, couvert séparément par les 24 séries ci-dessus. Les contrôles mémoire après préparation de chaque profil, Windows/WSL et vmstat restent dans les fichiers bruts.

## Code et tests prioritaires

Rejeu final après reconstruction de Next/Nest/collab/worker et migrations 0021–0029 : [parcours Edge complet](evidence/session-6d-functional/final-browser.txt), **97,566 s, un scénario intégré réussi**, aucune réponse 429 dans [la trace réseau](evidence/session-6d-functional/final-browser-requests.json). Guest qui met à jour son statut, neuf éditeurs, CAS avec saisie conservée, liens masqués, pagination, corps collaboratif à deux navigateurs, fermeture/réouverture hors ligne, vrai gel CDP, révocation/réattribution, interdiction du cache et logout. La pause de 65 secondes reste celle autorisée ; aucun quota/cadence de production changé.

L'audit adverse d'authentification et de fuites est également rejoué sur les sources finales : [neuf résultats réussis](evidence/session-6d-functional/final-adversarial.txt), incluant routes natives interdites, MFA/récupération, headers forgés, fermeture WSS après changement de facteur et canaris de bases. [184 erreurs, 97 entrées de journal, 8 emails et 30 canaris contrôlés](evidence/session-6d-functional/final-leaks.json), sans fuite dans ces canaux inspectés. Ces preuves complètent les tests de contention et d'équivalence ; elles ne remplacent pas les limites du tableau des risques.

Contrôle de publication final : [pnpm check complet](evidence/session-6d-functional/final-check.txt), hooks installés, lint, TypeScript, bootstrap Nest et **166 tests réussis / six SQL ignorés**, puis [six SQL réussis séparément](evidence/session-6d-functional/final-db.txt). Les deux journaux contiennent leur résumé final et `EXIT_CODE=0`. Aucun hook désactivé ; les différences postérieures au commit applicatif mesuré sont le sélecteur de plage du banc, la documentation et les preuves.

- `packages/db/drizzle/0021_database_barriers.sql` à `0029_cascade_subject_reconciliation.sql` et `packages/db/src/database-cells.ts` : barrières, recontrôle au commit, versions indépendantes, compteurs et liens masqués.
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

**Résultat final : les huit mutations passent chacune trois séries sur `fb8fb71`, la comparaison alternée respecte la marge et le parcours navigateur final passe.** Les sections suivantes conservent les versions et les arrêts précédents, distincts de la qualification finale en tête de fiche. La première série de dix minutes de rafraîchissement est conservée comme essai incomplet : requêtes réussies et hygiène sans swap, mais absence de télémétrie PostgreSQL à cause des séquences ANSI de Docker Windows. Le collecteur a été corrigé avec un test, puis les trois séries ont été rejouées intégralement. Ce premier essai ne compte pas parmi les trois résultats retenus.

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

| ID     | Risque / absence de preuve                                                                                                                                                  | Recommandation                                                                                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S6-R01 | Le rafraîchissement dépend du nombre d'onglets visibles, de workspaces et de lignes déjà cachées ; le scénario demandé ne couvre qu'une ligne persistée par compte          | Publier la charge exacte ; qualifier l'accumulation des caches et les usages multi-workspaces avant utilisation prolongée. Toute saturation mesurée exige un arbitrage de cadence, regroupement ou quotas. |
| S6-R02 | Mesures sur portable, pas sur l'hôte cible ; cinquante sockets au repos ne représentent pas cinquante rédacteurs et une recherche soutenue                                  | Maintenir la qualification 4 vCPU/8 Gio avec charge mixte de 50 comptes avant utilisateurs réels.                                                                                                          |
| S6-R03 | Cache hors ligne, onglet figé, exports et copies déjà détenus ne sont pas effaçables à distance                                                                             | Conserver les contrôles avant reprise, tombstones et options poste partagé/politique ; expliquer cette limite à l'exploitant.                                                                              |
| S6-R04 | Pagination sans instantané : modification d'une clé de tri pendant la navigation peut déplacer une ligne entre pages                                                        | Garder la sémantique documentée et proposer un rafraîchissement ; ne pas la présenter comme export exhaustif stable.                                                                                       |
| S6-R05 | Saisie relationnelle non confirmée conservée seulement dans l'onglet, contrairement au corps Yjs                                                                            | Garder la distinction explicite dans l'interface et le guide ; qualifier l'avertissement de départ dans la finition avant utilisateurs.                                                                    |
| S6-R06 | Crash testé sur processus d'agrégation, pas panne complète hôte/disque ; projection/worker indisponibles retardent recherche du corps et événements                         | Reprendre les essais de crash/sauvegarde/restauration en qualification et surveiller l'ancienneté des fenêtres/projections.                                                                                |
| S6-R07 | Historique Yjs disproportionné et ancienne information présente dans un document déjà reçu                                                                                  | Maintenir le rebasage inoccupé obligatoire avant usage prolongé et le plafond 1 Mio ; ne pas promettre l'effacement des copies antérieures.                                                                |
| S6-R08 | Les canaris ne démontrent pas l'absence universelle de fuite, ni une résistance aux sondes temporelles distribuées                                                          | Conserver R12/S5-R11 comme règles permanentes ; rejouer les attaques pour toute nouvelle route ou source de référence.                                                                                     |
| S6-R09 | Rétention/purge/anonymisation générale et livraison de webhooks restent hors session 6                                                                                      | Maintenir R13 avant utilisateurs réels ; vérifier alors les nouvelles tables, reçus, références personne, événements et audits.                                                                            |
| S6-R10 | Retrait d'une personne référencée massivement et valeurs aux bornes sur toutes les lignes non qualifiés par la seule fixture de droits                                      | Ajouter ce profil à la qualification, sans extrapoler les mesures de pages/lignes vides.                                                                                                                   |
| S6-R11 | Risques antérieurs de saturation globale, huit réservations mot de passe et ingénierie sociale opérateur                                                                    | Conserver les décisions datées de session 4 et les prérequis SaaS ; cette session ne constitue pas une nouvelle acceptation.                                                                               |
| S6-R12 | Restauration de colonnes absente de l'interface, finition visuelle et messages encore techniques                                                                            | Ajouter le panneau dans la finition avant utilisateurs ; restauration d'options/lignes et route de propriété restent distinctes.                                                                           |
| S6-R13 | Onze navigations automatiques en quatorze secondes atteignent L malgré la réussite de la charge nominale ; cadencer le test ne relève pas cette limite utilisateur          | Conserver les quotas conformément à la décision ; qualifier les parcours rapides et l'accumulation de caches avant toute modification de cadence ou quota.                                                 |
| S6-R15 | Le résolveur complet des droits ordinaires reste utilisé par les lectures qui en ont besoin ; son plan à 1 000 pages/profondeur 50 a coûté environ 1,7 s dans le diagnostic | Inclure arbre, recherche et contrôles de cache de pages ordinaires à la borne dans la qualification mixte. La correction mesurée cible les mutations d'arbre, pas toutes les lectures ordinaires.          |

## Relecture manuelle

Suivre le [guide consolidé à deux navigateurs](session-6-guide-manuel.md), notamment le prestataire qui met à jour le statut, les liens cachés conservés, le conflit explicite, les mouvements sans rapport pendant la saisie et le retrait/rétablissement avec un onglet hors ligne. Ce qui peut casser : ordre des verrous, époque base/ligne confondue avec la version d'une cellule, contrôle de droits oublié dans une projection ou un sélecteur, et trafic automatique sous-estimé. L'ancien blocage S6-R14 est résolu par les 24 séries et la comparaison finale, sans dérogation ni acceptation de risque.

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

### Retrait requalifié après 0029

Version applicative `79118cb6f5f0af666b19b39577a6c0887af69215`. [Trois séries complètes](evidence/session-6d-rights-remove-final/) sur la fixture pleine et cinq rédacteurs WSS ; mêmes plafonds, cadences et protocole mémoire.

| P95 (ms)             | Série 1 | Série 2 | Série 3 |  Médiane / plafond |
| -------------------- | ------: | ------: | ------: | -----------------: |
| Retrait HTTP         |  57,237 |  52,476 |  56,090 |       56,090 / 500 |
| Attente SQL observée |   8,425 |       0 |   9,129 |        8,425 / 100 |
| Reçu WSS, tous       |  22,715 |  19,654 |  19,300 |       19,654 / 200 |
| Reçu WSS chevauchant |  31,398 |  23,578 |  27,895 |       27,895 / 200 |
| Confirmation service |  17,696 |  14,472 |  12,928 | 14,472, indicateur |

Le zéro du collecteur SQL ne démontre pas une absence de contention : les sondes sont espacées de 5 ms, et une attente vue une seule fois a une durée observée nulle. La confirmation WSS est horodatée au reçu effectif. Les résultats très inférieurs aux plafonds sont conservés avec tous les échantillons et leur précision, sans relever les seuils.

Le scénario suivant a d'abord échoué dans la préparation HTTP de l'aperçu, avant mutation : le banc transmettait le bigint brut PostgreSQL comme chaîne, contrairement au contrat numérique des pages ordinaires. Le [contrôle HTTP de fixture](evidence/session-6d-functional/tree-version-preflight.txt) reproduit 400 avec cette chaîne puis 201 avec Number(version), aperçu de 40 pages. Seul le banc est corrigé (`e3d4bda9b6a7ed6baecc5239386afa89fb914dbc`) ; le contrat et l'application ne changent pas. Erreur initiale et trace de la série incomplète archivées. Reprise explicite à `--from-case move` avec nouvelle fixture ; aucune série incomplète n'est comptée.

### Interruption WSS et reprise du 28 octobre

Après correction du type de version du banc, la première série de déplacement s'interrompt avec `Unrelated native editor disconnected`. La fermeture du client en cours de reconnexion provoquait ensuite une erreur de nettoyage qui masquait cette assertion dans la console. La trace d'hygiène conserve la cause initiale ; aucun résultat partiel n'est retenu comme p95 et aucune explication réseau, quota ou autorisation n'est encore affirmée. Logs `tree-transport-error.txt/json` dans les preuves fonctionnelles.

Instrumentation du client de test seulement : mémoriser le code/reason canonique de fermeture, préserver la première cause et distinguer une erreur de transport réelle d'une fermeture volontaire en teardown. Aucun changement du serveur, des quotas ou des droits. Après cet ajout, la suite `database-services` passe ses dix résultats node:test (parent compris), avec refus d'accès, révocation, reconnexion et cache dans Chromium ; `cascade-services.txt` conserve le journal complet. Le scénario complet de l'interface 6c reste distinct et à rejouer sur la candidate finale.

La relance du 28 octobre s'arrête avant préparation : d'abord BatteryStatus=1, puis, après branchement confirmé BatteryStatus=2, Windows 2,35 Gio libres sous le minimum de 3 Gio ; WSL MemAvailable 5,40 Gio. Aucune série commencée ce jour à ce stade. Refus et relevés conservés (`tree-power-refusal.txt`, `tree-memory-refusal.txt/json`). Consommations ponctuelles, pas des mesures en charge : WSL 1,21 Gio, Docker Desktop 0,46 Gio, backend Docker 0,24 Gio, Edge 0,54 Gio, Node 0,31 Gio, PostgreSQL 197 Mio dans son conteneur. Le développeur est invité à libérer environ 1 Gio. Aucun changement des règles de mesure.

### Diagnostic confirmé du déplacement — 28 octobre 2026

Après libération de mémoire par le développeur, contrôle ponctuel Windows 5,112 Gio, WSL 5,42 Gio, BatteryStatus=2. La relance du banc passe ses garde-fous avant/après préparation, puis échoue dans la première mutation avec **1011 CONTROL_UNAVAILABLE**. Le nettoyage ne masque plus le motif. Aucune indication de quota dans cette fermeture ; aucune modification des quotas, délais ou contrôles applicatifs.

Deux reproductions instrumentées (`--diagnose-tree`) isolent une mutation HTTP réelle sur la même fixture pleine. Elles ne sont **pas des séries de qualification** : aucune médiane, aucun p95 ni conformité swap de série complète déduits de ces interruptions. Chaque préparation et départ vérifie secteur et mémoire ; les traces d'erreur conservent ces relevés. Le diagnostic ne journalise ni SQL brut ni paramètres : uniquement catégories fixes, durées, PID et blocages. Les deux traces sont archivées, sans remplacer l'essai initial.

| Observation, seconde reproduction                       |          Durée (ms) |
| ------------------------------------------------------- | ------------------: |
| Déplacement HTTP, réponse 201                           |           2 340,984 |
| `pageRights` lors de l'aperçu préalable                 |           1 726,077 |
| `pageRights` sous barrière de la mutation               |           1 800,495 |
| Calcul de l'aperçu sous barrière                        |             205,321 |
| COMMIT avec réconciliation                              |              25,804 |
| Appels de barrière des cinq rédacteurs, attente incluse | 2 120,128–2 294,162 |
| Renouvellement du leadership interrompu par son timeout |           1 506,265 |

Les catégories et durées viennent de [la trace PostgreSQL](evidence/session-6d-functional/tree-control-trace.json), le statut HTTP et le code WSS du [journal complet](evidence/session-6d-functional/tree-control-confirmed.txt). Les valeurs ne s'additionnent pas toutes : certaines sont concomitantes ; la durée d'un appel de barrière comprend son travail SQL, pas seulement l'attente. L'échantillonnage toutes les 100 ms prouve les blocages par `pg_blocking_pids`.

Chaîne réellement observée : backend de déplacement **60370** exécute `pageRights` ; rédacteur **60380** attend sa transaction dans `content_lock_document` ; renouvellement du leader **60378** attend la transaction 60380. Les autres rédacteurs attendent aussi 60370. `Store.transaction` acquiert aujourd'hui le verrou partagé du fence avant la barrière du document ; les attentes longues le conservent et empêchent l'UPDATE du lease. À 1 500 ms, le contrôle ferme les sockets par sécurité. La première reproduction montre la même chaîne (1 850,81 ms pour la requête ensuite identifiée, heartbeat expiré après 1 512,53 ms).

`PagesService.run` calcule les droits sur les 1 000 pages ordinaires, y compris pour l'aperçu et les mutations d'arborescence qui utilisent le contexte de membre et non cette carte. C'est l'appel lent identifié ; son plan détaillé reste à profiler avant optimisation. L'aperçu compare également le workspace entier, puis filtre les effets au sous-arbre de 40 pages. Le diagnostic n'attribue pas à la seule réconciliation différée un coût qui vient surtout de ces contrôles précédents.

**Arrêt et recommandation** : profiler le plan du contrôle de droits, cibler les calculs nécessaires à l'arborescence avec preuve d'équivalence, puis éviter que l'attente de sa barrière bloque le renouvellement du leadership. Conserver contrôle de session/politique/droits, fence valide jusqu'au commit, CAS, token d'aperçu, délais et fermeture de sécurité. Ajouter une contention prolongée réelle et vérifier absence d'écriture avec leader perdu. Aucun correctif de ces chemins dans cette livraison ; arbitrage demandé avant de continuer. Les autres mesures, la comparaison alternée et le scénario Edge final restent différés.

Contrôle de publication du 28 octobre : `pnpm check` complet, hooks installés, lint, TypeScript, bootstrap Nest, **166 tests réussis / six SQL ignorés**, 30 fichiers réussis / un ignoré ; [journal complet](evidence/session-6d-functional/control-diagnostic-check.txt), code de sortie 0. Les six tests SQL et les dix scénarios de cascade restent prouvés séparément sur la migration 0029 ; aucun code applicatif n'a changé après ces tests. Les dix résultats `database-services` du 28 octobre couvrent le client WSS instrumenté. Les échecs du banc de déplacement sont explicitement conservés et bloquants ; ils ne sont pas inclus dans les tests réussis.

### Correction d'arborescence autorisée, 28 octobre

Le développeur choisit ensuite « Profiler puis corriger ces deux chemins ». Diagnostic précédent poussé et vérifié : `2ca2303d19a9dc6de5a45161d504031b437ca551`. [Trois séries de plans](evidence/session-6d-tree-profile/) sur cette version applicative, sans rédacteur, avant correction ; secteur et mémoire conformes, dix intervalles vmstat sans swap par série. Une mutation native et ses plans par série : diagnostic, pas qualification p95.

EXPLAIN ANALYZE du résolveur : **1 689,01 / 1 688,89 / 1 712,34 ms** ; de son corps SQL : **1 752,40 / 1 744,08 / 1 777,40 ms** ; de l'aperçu : **257,85 / 260,19 / 252,97 ms**. Le corps expliqué est extrait de la fonction réellement installée, avec les arguments natifs capturés, après restauration de la fixture et sous la barrière réelle. Première série : 25 500 ancêtres rescannés mille fois (25,5 millions de lignes filtrées, environ 1 260 ms inclusifs). Mille appels de politique, deux mille de vérification forte ; environ 376 ms inclusifs de politique. Les coûts s'emboîtent. Diagnostic présenté avant modification.

Les mutations/aperçus d'arbre utilisent désormais le contexte verrouillé de membre, `requireTreeManager` et la validation de l'arbre, sans construire une carte guest inutilisée. Les autres routes qui consomment cette carte gardent le résolveur. L'aperçu calcule seulement les guests et descendants concernés ; version d'accès et token signé restent revalidés dans la transaction. CAS des pages et effets de recherche/audit/outbox regroupés en SQL, mêmes versions et une entrée d'audit/événement par page, mutex de projection en ordre UUID. Rien n'est calculé hors verrou.

Ouverture, journal et projection attendent leurs barrières et mutex avant de garder le verrou partagé du fence. Celui-ci est ensuite vérifié dans une commande SQL distincte, puis retenu au commit. Aucun délai relevé. La perte du leader pendant attente refuse encore le journal.

Preuves réelles : **12 résultats HTTP/WSS**, dont attente volontaire de 3,3 s pour append/open/projection, renouvellement effectif du lease et sockets conservées, puis backend du leader tué et journal inchangé ; **20 de sécurité SQL**, dont révocation pendant attente ; **7 partages HTTP/WSS**, **8 pages**, **un scénario de 40 pages** (effets, conflit, refus guest, erreur injectée après recherche annulant tous les effets). Oracle permanent : **500 transactions / 1 015 opérations, 333 aperçus ciblés comparés au calcul complet**, graine 1780491792. Journaux `tree-contention.txt`, `tree-access-security.txt`, `tree-shares.txt`, `tree-pages.txt`, `tree-effects.txt`, `tree-preview-random.txt` dans les preuves fonctionnelles.

Échecs intermédiaires conservés : le nouveau test de contention ajoutait un mot sans séparateur et cassait la recherche du test suivant ; fixture corrigée. Le premier test d'arbre révèle une liaison UUID[] incorrecte, corrigée par paramètre SQL explicite. Aucun quota contourné. `pnpm check` repasse avec 166 réussis / six SQL ignorés ; [journal complet](evidence/session-6d-functional/tree-final-check.txt). Requalification des plafonds encore requise avant clôture.
