# Session 6a — fiche finale de la preuve

26 octobre 2026. **6a terminée pour le périmètre de preuve avant interface.** Les deux mesures différées passent : tableau à 10 000 lignes / 50 propriétés et cellules pendant l'édition Yjs sur la version durcie. Aucun plafond relevé, aucune optimisation applicative dans cette reprise. Le protocole mémoire a été remplacé sur décision du développeur, après le diagnostic du cache disque WSL.

Code mesuré : **`850162f29715f911c9448b624f45494066a8dd1f`**, qui ajoute le garde-fou et son instrumentation à `67ba810`. Le commit de cette fiche ne change pas ce code. Le hash final publié est vérifié par `git ls-remote` dans le compte rendu et `.local/session-6a-publication-status.md` ; création/fusion de PR réservées au développeur.

## Lire en priorité

1. [Protocole dans ARCHITECTURE.md](../../ARCHITECTURE.md), [garde-fou](../../scripts/measurement-memory.mjs) et [dix tests](../../scripts/measurement-memory.test.mjs) : admission mémoire, sonde continue, refus et rejeu.
2. [Banc du tableau](../../apps/collab/src/testing/database-table-load.e2e.ts) et [banc cellules/WSS](../../apps/collab/src/testing/database-cells-load.e2e.ts) : ce qui est chronométré et les assertions réellement exécutées.
3. [Fiche cellules/arborescence](session-6-6a-cellules-et-arborescence.md) : noyau transactionnel, migrations 0024–0026, tests PostgreSQL, équivalence aléatoire et guide détaillé à deux clients. [Profilage du rôle](session-6-6a-optimisation-barrieres.md) : diagnostic avant optimisation.
4. [Configuration et migration coordonnée](../database-deployment.md) : bornes de déploiement et absence de migration des données de travail pendant ces essais.

## Protocole exécuté

Secteur `BatteryStatus=2` avant chaque série ; aucun build ni autre test en parallèle. Compilation terminée avant préparation. Trois séries par cas, 200 échantillons par série du tableau après trois échauffements ; plans `EXPLAIN (ANALYZE, BUFFERS)` conservés, hors échantillons chronométrés. Les valeurs publiées sont les trois p95 et leur médiane, sans élimination d'une série lente.

Avant préparation : Windows **4,559 Gio** pour le tableau, **3,250 Gio** pour les cellules, donc ≥3 Gio. Après préparation : seuils Windows ≥1,5 Gio et WSL `MemAvailable` ≥2 Gio. Minima des relevés avant/après séries : **2,859 Gio Windows et 5,273 Gio WSL**. La disponibilité WSL n'est pas additionnée à Windows.

**27 séries, 442 intervalles vmstat, zéro swap, aucun rejeu nécessaire.** `si/so` n'ont jamais quitté zéro et les compteurs `pswpin/pswpout` n'ont pas progressé. Chaque trace contient les lignes brutes et leurs heures de réception, les deux snapshots mémoire/secteur, l'identité du noyau WSL, l'image de sonde, les bornes temporelles du travail et son résultat. Sonde Ubuntu locale, sans réseau, volume ni privilège, arrêtée après chaque série. Les deux refus antérieurs sous l'ancien protocole restent [archivés](session-6-6a-reprise-memoire.md), sans qualification rétroactive.

Sources complètes : [tableau, journal](evidence/session-6a-hygiene/table-measurement.txt), [échantillons et plans](evidence/session-6a-hygiene/table-measurement.json), [cellules, journal](evidence/session-6a-hygiene/cell-measurement.txt), [échantillons](evidence/session-6a-hygiene/cell-measurement.json), [index des 27 traces](evidence/session-6a-hygiene/index.json). Les chemins `.local/measurement-hygiene/` des rapports sont leur provenance d'origine ; leurs fichiers sont archivés à côté de l'index avec le même nom. Les deux relevés avant préparation y sont également conservés.

## Tableau à 10 000 lignes et 50 propriétés

Neuf types, 100 options par propriété, valeurs absentes, cellules d'ensembles pleines jusqu'aux bornes, 50 cibles de relation, 20 personnes, pages de 50 lignes. Sélection puis hydratation des propriétés, versions et références autorisées, sérialisation JSON et commit compris dans le chronométrage. Les scénarios invités vérifient aussi qu'aucun identifiant de cible masquée ne sort dans le résultat. La préparation du curseur profond utilise un ancrage hors chronométrage, puis les échantillons utilisent la pagination par clés.

| p95 serveur en ms                      | Série 1 | Série 2 | Série 3 |    Médiane | Plafond |
| -------------------------------------- | ------: | ------: | ------: | ---------: | ------: |
| Owner — deux tris, filtre peu sélectif |   71,97 |   76,44 |   78,82 |  **76,44** |    <200 |
| Owner — pagination après 9 000 lignes  |   49,94 |   48,54 |   41,73 |  **48,54** |    <200 |
| Owner — dix filtres ET                 |  161,72 |  155,61 |  158,18 | **158,18** |    <200 |
| Owner — descendant et valeurs vides    |   47,96 |   48,01 |   57,87 |  **48,01** |    <200 |
| Guest — deux tris, filtre peu sélectif |   86,05 |   69,76 |   71,45 |  **71,45** |    <200 |
| Guest — pagination après 9 000 lignes  |   50,81 |   49,05 |   53,84 |  **50,81** |    <200 |
| Guest — dix filtres ET                 |  139,86 |  148,72 |  139,99 | **139,99** |    <200 |
| Guest — descendant et valeurs vides    |   54,84 |   57,03 |   54,18 |  **54,84** |    <200 |

Les huit médianes et les 24 p95 individuels passent. **Périmètre : preuve de requêtes SQL fermées**, pas encore une API de tableau. Compilateur AST général, curseurs signés, quotas/admission HTTP et indexation/recherche de production restent en 6b. Ces huit cas ne couvrent pas toutes les distributions de valeurs ni toutes les combinaisons de filtres.

## Cellules finales pendant Yjs

Deux sessions réelles, deux providers sur le même corps de ligne, 100 commits scalaires et 100 commits d'ensemble par série ; 30 paires concurrentes sur la même cellule, une réussite et un conflit attendus par paire. Convergence Yjs vérifiée après chaque série. Mesure du noyau jusqu'à sérialisation/commit, sans future façade HTTP. Les reçus traversent WSS/Caddy avec TLS vérifié.

| p95 en ms                              | Série 1 | Série 2 | Série 3 |   Médiane | Plafond |
| -------------------------------------- | ------: | ------: | ------: | --------: | ------: |
| Cellule scalaire                       |   25,08 |   28,63 |   23,39 | **25,08** |    <100 |
| Cellule ensemble                       |   26,97 |   30,08 |   27,65 | **27,65** |    <100 |
| Paire conflictuelle, diagnostic séparé |   39,71 |   24,23 |   31,34 | **31,34** |       — |
| Confirmation durable reçue en WSS      |   19,08 |   17,08 |   22,03 | **19,08** |    <200 |

70 reçus par série. Les conflits ne sont pas mélangés aux commits réussis. Cette campagne remplace la mesure exploratoire antérieure au durcissement ; aucune comparaison de régression entre protocoles différents n'est revendiquée. Petits corps Yjs, deux rédacteurs locaux : ni WAN, ni profils 1 Mio, ni charge de cinquante comptes déduits de ces chiffres.

## Contrôles et limites de 6a

Le [contrôle complet](evidence/session-6a-hygiene/check.txt) finit à `EXIT_CODE=0` : hooks installés, lint, types, consommation NestJS et **146 tests réussis**, dont dix nouveaux pour le garde-fou ; six tests SQL ignorés dans cette commande. Les [six SQL exécutés séparément](evidence/session-6a-final-db.txt) et les [19 tests de cellules](evidence/session-6a-cells-final.txt) appartiennent à la campagne antérieure sur le même code applicatif. Ils ne sont pas présentés comme relancés ici.

Le garde-fou teste les seuils exacts, les indicateurs manquants, les compteurs du noyau, une sonde incohérente/interrompue, le rejeu sans mélange des échantillons, l'arrêt après trois tentatives avec swap et les erreurs de travail/nettoyage. Le swap est **simulé dans ces tests**, pas provoqué sur la machine ; les 27 séries donnent la preuve réelle du chemin sans swap. Les anciens runners de mesure doivent intégrer ce garde-fou avant leur prochaine qualification, notamment la comparaison alternée de 6d.

Les preuves antérieures restent valables dans leur périmètre : rôle sous charge, arbre sur 1 000 pages / 50 000 lignes / 100 memberships / 5 000 grants, 500 transactions aléatoires (1 015 opérations tirées, graine 1780491792), oracle complet et courses SQL. Les migrations et les contrôles de session/assurance/politique/droits n'ont pas changé pendant cette reprise. Aucun calcul déplacé hors verrou, aucune protection retirée.

Restent en 6b : CRUD/quotas, limites de création atomiques, AST et curseurs, recherche et agrégation outbox. Tickets natifs de lignes et cache base/ligne sont à intégrer et attaquer avant leur ouverture ; interface et cache en 6c. Revue adverse, charge et comparaison alternée finale avec main en 6d. R12/S5-R11 et qualification dédiée 4 vCPU / 8 Gio à cinquante comptes restent obligatoires. Aucun nouveau risque accepté par cette fiche.

## Guide manuel à deux clients — 10 à 15 minutes

Utiliser PostgreSQL local, `.env` préparé, `pnpm install` et `pnpm hooks:install`. Les commandes ci-dessous utilisent un schéma de test isolé ; elles ne nécessitent pas de migrer les données de travail. Le [guide détaillé précédent](session-6-6a-cellules-et-arborescence.md#guide-manuel-à-deux-clients-1015-minutes) reste applicable.

1. Terminal fixture : `pnpm proof:databases serve`. Ouvrir deux autres terminaux A et B à la racine du dépôt, conserver la fixture ouverte.
2. A : `pnpm proof:databases owner read text` ; B : `pnpm proof:databases guest read text`. Attendre cellule vide, version 0.
3. A : `pnpm proof:databases owner write text 0 "Texte A"` ; B : `pnpm proof:databases guest write number 0 42`. Les cellules différentes réussissent indépendamment à version 1.
4. B : `pnpm proof:databases guest write text 0 "Texte B"` : attendre `409 CELL_VERSION_CONFLICT`, sans écrasement. Relire puis écrire à version 1 : succès à version 2. A écrit ensuite `owner write text 2 ""` : vide à version 3 ; une écriture avec version 0 reste refusée.
5. A : `pnpm proof:databases grant read` ; B peut lire mais ne peut plus écrire. `grant none` retire aussi la lecture, sans valeur dans l'erreur. `grant edit` redonne l'accès avec les versions courantes.
6. Entrée dans le terminal fixture : nettoyage. Les courses de références masquées, schéma, rollback et révocation sont reproductibles par `pnpm test:collab:e2e --suite database-cells` ; le corps simultané par le banc suivant. Ce guide utilise des clients de preuve en terminal, pas une interface de base déjà livrée.
7. Pour reproduire les performances, sur secteur et sans autre build/test : `pnpm test:collab:e2e --suite database-table-load`, puis `pnpm test:collab:e2e --suite database-cells-load`. L'image locale `ubuntu:24.04` avec procps est requise ; si absente, la préparer avant la campagne, jamais pendant. Le runner refuse toute sonde absente et applique les seuils du protocole. Ne pas activer `MEMORIA_DATABASE_TABLE_SMOKE`, qui n'effectue aucune mesure.

Ce qui pourrait casser : oubli d'un sous-arbre dans une transaction composée, inversion d'ordre des verrous, façade qui divulgue une référence masquée, ancien writer restant actif lors d'une migration. Les oracles et courses couvrent les mécanismes du noyau ; les futures façades devront passer leurs propres attaques. Le déploiement coordonné sur les données de travail n'a pas été exécuté ici.

## Relevés des trois indicateurs, série par série

Toutes les valeurs sont en Gio ; `BatteryStatus=2` sur chaque relevé. Chaque lien donne la trace brute et les compteurs, pas seulement le résultat résumé. `si=so=0` sur chacun des 442 intervalles et deltas de compteurs nuls.

| Série                                                                                                                                           | Windows avant → après (Gio) | WSL avant → après (Gio) | Intervalles si/so = 0 |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------: | ----------------------: | --------------------: |
| [table-owner-broad-1](evidence/session-6a-hygiene/database-table-owner-broad-1-attempt-1-fc5ca294-af8d-4a5a-9562-687b8d0db707.json)             |               3.338 → 3.254 |           5.498 → 5.492 |                    16 |
| [table-owner-broad-2](evidence/session-6a-hygiene/database-table-owner-broad-2-attempt-1-00503efd-e55a-4e7a-84e5-971608161a2c.json)             |               3.224 → 3.232 |           5.492 → 5.494 |                    16 |
| [table-owner-broad-3](evidence/session-6a-hygiene/database-table-owner-broad-3-attempt-1-7b24ccdb-98e2-4ab1-8717-f4f558ce0528.json)             |               3.224 → 3.223 |           5.493 → 5.496 |                    16 |
| [table-owner-deep-1](evidence/session-6a-hygiene/database-table-owner-deep-1-attempt-1-ad9fe650-1811-45d8-ad9b-49a46e0a9b68.json)               |               3.205 → 3.215 |           5.498 → 5.494 |                    11 |
| [table-owner-deep-2](evidence/session-6a-hygiene/database-table-owner-deep-2-attempt-1-fed37451-7402-40ab-b169-ae034d40e21e.json)               |               3.228 → 3.224 |           5.496 → 5.501 |                    10 |
| [table-owner-deep-3](evidence/session-6a-hygiene/database-table-owner-deep-3-attempt-1-242dab02-05e3-4fba-bf70-05ca2d783b61.json)               |               3.189 → 3.200 |           5.498 → 5.494 |                    10 |
| [table-owner-ten-filters-1](evidence/session-6a-hygiene/database-table-owner-ten-filters-1-attempt-1-037d8ac7-4f1d-4283-a067-55bdb9d2471e.json) |               3.207 → 3.130 |           5.496 → 5.422 |                    33 |
| [table-owner-ten-filters-2](evidence/session-6a-hygiene/database-table-owner-ten-filters-2-attempt-1-1a0ae3ce-0560-4013-8fa1-4f5e44d2b1db.json) |               3.125 → 3.113 |           5.410 → 5.352 |                    32 |
| [table-owner-ten-filters-3](evidence/session-6a-hygiene/database-table-owner-ten-filters-3-attempt-1-ddccfa89-4c44-4b22-9f91-908c5ae7e85f.json) |               3.089 → 3.061 |           5.351 → 5.322 |                    32 |
| [table-owner-nulls-desc-1](evidence/session-6a-hygiene/database-table-owner-nulls-desc-1-attempt-1-b680dade-c610-4b71-9f10-100a9f6a9c83.json)   |               3.065 → 3.078 |           5.324 → 5.322 |                    11 |
| [table-owner-nulls-desc-2](evidence/session-6a-hygiene/database-table-owner-nulls-desc-2-attempt-1-24d68fa6-4028-4454-af31-1169924d9529.json)   |               3.056 → 3.066 |           5.333 → 5.339 |                    11 |
| [table-owner-nulls-desc-3](evidence/session-6a-hygiene/database-table-owner-nulls-desc-3-attempt-1-fce00283-555b-40b6-9c73-b301a68cdb0e.json)   |               3.049 → 2.969 |           5.336 → 5.337 |                    12 |
| [table-guest-broad-1](evidence/session-6a-hygiene/database-table-guest-broad-1-attempt-1-9c366611-d4c4-454f-982e-e8b4270e1135.json)             |               2.963 → 2.908 |           5.337 → 5.367 |                    16 |
| [table-guest-broad-2](evidence/session-6a-hygiene/database-table-guest-broad-2-attempt-1-6329da81-f1e7-4e3f-8e1d-d73b946912b7.json)             |               2.859 → 2.925 |           5.362 → 5.368 |                    16 |
| [table-guest-broad-3](evidence/session-6a-hygiene/database-table-guest-broad-3-attempt-1-53f6d6de-28d7-4508-8e33-e88b425582ba.json)             |               2.909 → 3.057 |           5.382 → 5.386 |                    16 |
| [table-guest-deep-1](evidence/session-6a-hygiene/database-table-guest-deep-1-attempt-1-81ccf332-8681-4f57-a8ae-33791e49520e.json)               |               3.029 → 3.028 |           5.392 → 5.394 |                    11 |
| [table-guest-deep-2](evidence/session-6a-hygiene/database-table-guest-deep-2-attempt-1-5d7e2768-4414-4e11-89ec-c5f3f017e083.json)               |               2.992 → 2.984 |           5.393 → 5.406 |                    11 |
| [table-guest-deep-3](evidence/session-6a-hygiene/database-table-guest-deep-3-attempt-1-26203992-78bb-4cb3-bd83-c3a2a6e68fa4.json)               |               2.993 → 2.979 |           5.408 → 5.403 |                    12 |
| [table-guest-ten-filters-1](evidence/session-6a-hygiene/database-table-guest-ten-filters-1-attempt-1-6e669b4c-c10c-4e0e-b9e7-71750af130a9.json) |               2.948 → 2.986 |           5.412 → 5.368 |                    29 |
| [table-guest-ten-filters-2](evidence/session-6a-hygiene/database-table-guest-ten-filters-2-attempt-1-5a1606a8-cb4c-45d4-8b68-af9ebc7befaa.json) |               2.975 → 2.999 |           5.364 → 5.356 |                    29 |
| [table-guest-ten-filters-3](evidence/session-6a-hygiene/database-table-guest-ten-filters-3-attempt-1-f9a75c51-23aa-4d58-85e3-7114de4960ec.json) |               2.978 → 2.978 |           5.357 → 5.342 |                    29 |
| [table-guest-nulls-desc-1](evidence/session-6a-hygiene/database-table-guest-nulls-desc-1-attempt-1-08d7d7d2-04f3-4f6d-9f9a-a332cac12512.json)   |               2.960 → 3.138 |           5.334 → 5.342 |                    12 |
| [table-guest-nulls-desc-2](evidence/session-6a-hygiene/database-table-guest-nulls-desc-2-attempt-1-b4d7ebca-630f-48af-8e8d-efbecf0843ff.json)   |               3.128 → 3.134 |           5.346 → 5.345 |                    12 |
| [table-guest-nulls-desc-3](evidence/session-6a-hygiene/database-table-guest-nulls-desc-3-attempt-1-5d336ab3-6ec7-435b-b8da-234c9be643c6.json)   |               3.121 → 3.167 |           5.346 → 5.350 |                    12 |
| [cells-1](evidence/session-6a-hygiene/database-cells-1-attempt-1-959012c7-fd73-4904-aa3a-b33c6e69e4a6.json)                                     |               3.429 → 3.487 |           5.321 → 5.313 |                     9 |
| [cells-2](evidence/session-6a-hygiene/database-cells-2-attempt-1-eda5f7fd-2fa9-4a9c-865c-bb29ddba4147.json)                                     |               3.473 → 3.572 |           5.296 → 5.296 |                     9 |
| [cells-3](evidence/session-6a-hygiene/database-cells-3-attempt-1-f61844b9-6f7a-4946-9e6e-b2a661d4eb3c.json)                                     |               3.569 → 3.550 |           5.289 → 5.273 |                     9 |
