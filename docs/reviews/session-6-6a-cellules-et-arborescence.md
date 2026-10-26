# Session 6a — sous-arbres, cellules et preuve d’équivalence

26 octobre 2026. **Livraison intermédiaire : 6a reste ouverte.** Les mutations d’arborescence passent leurs plafonds après réconciliation ciblée. Le noyau de cellules et les courses PostgreSQL sont testés. Le banc du tableau est différé : après préparation, seulement 2,762 Gio étaient disponibles. Le développeur a expressément maintenu le minimum de **3 Gio** ; aucun résultat de performance du tableau n’est revendiqué. Ni interface ni nouvelle route de bases livrée.

Commits de code : `429cab0` (migrations, portées et oracles) puis `8d9372b` (noyau de cellules et clients de preuve). La publication de l’ensemble, fiche comprise, est vérifiée après push dans `.local/session-6a-publication-status.md` et dans le compte rendu ; la fiche n’incorpore pas un hash autoréférentiel.

**Reprise suivante, même jour :** la candidate `2dcc4f9` a de nouveau préparé le tableau, puis refusé le premier échantillon à **2,751 Gio** malgré 4,103 Gio disponibles avant lancement. Aucun p95 obtenu, banc cellules non lancé ; 6a reste ouverte. Le [diagnostic de mémoire](session-6-6a-reprise-memoire.md) donne les consommations WSL/Docker, PostgreSQL et Node, sans modification applicative ni optimisation.

## Fichiers prioritaires

1. [Migration 0024](../../packages/db/drizzle/0024_subtree_reconciliation.sql) : portée par sous-arbre, union dans la transaction et repli global. [Oracle à pleine taille](../../apps/collab/src/testing/reconciliation-tree.e2e.ts) et [test aléatoire](../../apps/collab/src/testing/reconciliation-random.e2e.ts).
2. [Noyau DatabaseCells](../../packages/db/src/database-cells.ts), [état 0025](../../packages/db/drizzle/0025_database_cell_state.sql), [barrières de définition 0026](../../packages/db/drizzle/0026_database_definition_boundaries.sql), [19 tests PostgreSQL](../../apps/collab/src/testing/database-cells.e2e.ts).
3. [Banc d’arborescence](../../apps/collab/src/testing/databases-tree-load.ts), [rédacteurs WSS](../../apps/collab/src/testing/database-wss-writers.ts), [banc cellules](../../apps/collab/src/testing/database-cells-load.e2e.ts) et [requêtes de preuve du tableau](../../apps/collab/src/testing/database-table-load.e2e.ts).
4. [Client manuel](../../apps/collab/src/testing/manual-database-cells.ts) et guide ci-dessous. Les valeurs de déploiement restent dans [database-deployment.md](../database-deployment.md).

## Arborescence : échec initial puis portée réduite

Fixture identique : **1 000 pages ordinaires, 50 bases, 50 000 lignes, 100 memberships, 5 000 partages**, profondeur 50. Le nœud modifié appartient à une branche de 40 pages. Les quatre rédacteurs utilisent trois lignes de bases distinctes et une page ordinaire hors du sous-arbre modifié.

Avant 0024, un déplacement/archivage/restauration recalculait tous les droits ordinaires. L’attente SQL médiane des p95 était **131,59 / 188,63 / 185,56 ms**. Les confirmations WSS étaient **153,73 / 210,34 / 208,10 ms**. Les seuils échouaient ; l’échec a été signalé avant modification. [Journal initial](evidence/session-6a-tree-before.txt), [trois séries initiales complètes](evidence/session-6a-tree-before.json).

0024 capture les descendants **après chaque mutation**, y compris les nœuds archivés, et réunit toutes ces portées. Un descendant déplacé ensuite reste dans l’union. La portée personnes de 0023 et la portée pages se combinent en un sur-ensemble sûr ; `NULL` signifie global sur l’axe concerné et domine l’union. Suppression physique/cascade ou sujet inconnu : repli global. Le trigger différé lit la portée finale, et non celle du premier événement. Seuls les couples dont le niveau change prennent une nouvelle époque.

Les barrières, la transaction et les contrôles session/assurance/politique/droits sont conservés. **Aucun calcul n’est déplacé hors verrou**, donc aucune précondition optimiste nouvelle n’est nécessaire. Le parcours des ancêtres reste complet ; seuls les résultats destinataires participent au produit personnes/pages et à la comparaison.

Protocole avant/après identique : 32 fenêtres isolées par série et opération, les deux premières exclues ; mutation SQL réelle jusqu’au commit, puis 200 ms d’écriture supplémentaire. La remise à l’état initial s’effectue hors fenêtre. Trois séries sur secteur, RAM ≥3 Gio, sans autre build/test. Ce protocole est distinct de la pression continue du précédent banc de rôle : pas de comparaison de pourcentage entre ces deux campagnes.

| Après 0024, p95 en ms               | Série 1 | Série 2 | Série 3 | Médiane | Plafond |
| ----------------------------------- | ------: | ------: | ------: | ------: | ------: |
| Déplacement — mutation              |   31,24 |   36,14 |   30,62 |   31,24 |    <500 |
| Déplacement — attente SQL observée  |   17,35 |   14,78 |   16,09 |   16,09 |    <100 |
| Déplacement — confirmation service  |   31,25 |   32,04 |   30,49 |   31,25 |    <200 |
| Déplacement — reçu WSS              |   35,24 |   35,95 |   34,46 |   35,24 |    <200 |
| Archivage — mutation                |  100,57 |  103,36 |   84,06 |  100,57 |    <500 |
| Archivage — attente SQL observée    |   80,91 |   76,31 |   65,96 |   76,31 |    <100 |
| Archivage — confirmation service    |   97,49 |   93,72 |   82,77 |   93,72 |    <200 |
| Archivage — reçu WSS                |  101,39 |   97,93 |   86,61 |   97,93 |    <200 |
| Restauration — mutation             |   83,67 |   83,79 |   93,25 |   83,79 |    <500 |
| Restauration — attente SQL observée |   66,22 |   65,31 |   67,77 |   66,22 |    <100 |
| Restauration — confirmation service |   81,66 |   82,66 |   84,88 |   82,66 |    <200 |
| Restauration — reçu WSS             |   85,76 |   86,64 |   88,93 |   86,64 |    <200 |

[Journal après](evidence/session-6a-tree-after.txt), [échantillons et relevés](evidence/session-6a-tree-after.json). RAM avant les neuf séries : 3,318 / 3,305 / 3,315 / 3,334 / 3,312 / 3,272 / 3,271 / 3,247 / 3,236 Gio ; `BatteryStatus=2` partout. Chaque série comporte 30 mutations et 150 à 209 reçus WSS retenus. Les p95 individuels passent aussi.

WSS réel via Caddy isolé, TLS vérifié, session Better Auth et reçu durable lié au hash/génération de l’update. L’attente SQL est une borne inférieure observée par échantillonnage, pas le compteur exact interne PostgreSQL. Le trajet WSS inclut le délai réellement reçu. La mutation reste SQL, **pas HTTP** ; les documents sont petits. La portée des lignes est apportée par un adaptateur de fixture qui appelle le vrai résolveur, pas par une nouvelle route native de tickets.

## Équivalence permanente

Graine **1780491792** (`0x6a202610`) : **500 transactions, 1 015 opérations tirées** sur rôles, grants/sujets, déplacements, archivages/restaurations, retraits/réinscriptions et rollbacks. Après chaque étape : égalité avec le calcul complet, file différée vide, époque intacte des droits inchangés et absence de changement après rollback. Les identités de membership ne sont pas réutilisées après retrait. Le [journal](evidence/session-6a-random-final.txt) et la [séquence enregistrée](evidence/session-6a-reconciliation-random.json) sont conservés.

En cas d’écart, le test écrit la graine et la séquence complète, réduit les transactions puis leurs opérations par relectures PostgreSQL et vérifie que le résultat reproduit encore l’écart. Garantie annoncée : **1-minimal pour la suppression d’une transaction**, opérations réduites ; pas une recherche exhaustive de la plus courte séquence possible. Le réducteur a son test déterministe ; aucun écart SQL n’a nécessité son déclenchement dans cette campagne. Un [test supplémentaire à pleine taille](evidence/session-6a-tree-oracle.txt) compare aussi déplacement, archivage, restauration, descendant déplacé après archivage dans une même transaction et rollback au calcul complet.

## Cellules et références

`DatabaseCells` est le noyau transactionnel partagé, exercé directement par les preuves. Les façades HTTP et leurs quotas viendront en 6b. Ordre : accès initial, plan de bases/lignes, barrières partagées en ordre UUID, relecture d’accès/schéma, verrou propre à la cellule, validation, valeurs/version/marque durable, dernier contrôle d’accès, commit. Une relation dont les cibles ont changé pendant l’attente impose un nouveau plan au lieu de prendre des verrous tardifs hors ordre.

La cellule vide conserve son tombstone de version. Deux propriétés de la même ligne n’ont pas le même CAS ; un ensemble multi-select a un CAS unique. La révision agrégée est stockée séparément du verrou de cycle de vie, sans promotion SHARE→UPDATE. Elle ne touche ni version de titre ni journal Yjs. La marque sale est durable, mais **le worker outbox/recherche/audit agrégé reste en 6b**.

Relations/personnes : seuls les éléments visibles sont ajoutables/retirables ; `clearVisible` garde les éléments cachés. Réponse cachée unique `hasHidden`, sans ID/titre/nombre. Cible inconnue, inaccessible ou hors base : même erreur. Retrait d’une personne référencée par 10 000 cellules : détachement de la référence stable, aucun effacement en cascade de ces valeurs, aucune résurrection lors d’une réinscription. Options archivées conservables/retirables mais non assignables ; type/mode/base cible peuplés immuables. Définition/options/vue/liste assignable prennent la barrière exclusive de base ; le service garde le CAS de schéma.

### Mesure exploratoire cellules pendant Yjs

Deux comptes et deux providers écrivent dans le même corps, avec 100 mutations scalaires, 100 d’ensemble et 30 paires conflictuelles par série. Mesure du noyau jusqu’à sérialisation/commit, sans HTTP. Convergence Yjs vérifiée.

| p95 en ms        | Série 1 | Série 2 | Série 3 | Médiane |
| ---------------- | ------: | ------: | ------: | ------: |
| Cellule scalaire |   23,60 |   22,54 |   22,77 |   22,77 |
| Cellule ensemble |   27,07 |   26,21 |   27,07 |   27,07 |
| Reçu durable WSS |   20,58 |   13,75 |   14,07 |   14,07 |

Secteur et 3,48–3,58 Gio libres ; 70/68/68 reçus. [Journal](evidence/session-6a-cell-measurement.txt), [données](evidence/session-6a-cell-measurement.json). **Mesure antérieure aux derniers durcissements 0026/options archivées/lecture cohérente : à reprendre sur la candidate finale avant clôture de 6a.** Elle valide la direction, pas la performance finale de tous les chemins. Pas de WAN, de corps 1 Mio ni de cinquante rédacteurs déduits de cette preuve.

## Vérifications et absences explicites

| Sujet                                                               | Preuve réelle                                                                                                                                                                                                                                                              | Limite                                                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| CAS, neuf types, schéma/cycle de vie, relations/personnes, rollback | [19 tests PostgreSQL](evidence/session-6a-cells-final.txt)                                                                                                                                                                                                                 | Pas de route de cellules HTTP ; noyau appelé avec identité de session de fixture          |
| Équivalence ciblée                                                  | 500 transactions + test du réducteur + oracle pleine taille                                                                                                                                                                                                                | Une graine enregistrée, pas tous les arbres possibles                                     |
| Partages / fermeture / assurance                                    | [14 tests HTTP/WS](evidence/session-6a-final-sharing.txt), [7 tests de partages ciblés](evidence/session-6a-final-shares.txt), [13 tests de politique](evidence/session-6a-final-workspace.txt)                                                                            | Routes existantes ; ne qualifie pas de nouveaux tickets natifs de lignes                  |
| Contraintes Drizzle                                                 | [6 tests SQL](evidence/session-6a-final-db.txt), migrations appliquées dans chaque fixture                                                                                                                                                                                 | Déploiement coordonné réel non exécuté sur les données de travail                         |
| Guide deux clients                                                  | [Essai des deux processus clients](evidence/session-6a-manual.txt)                                                                                                                                                                                                         | Terminaux locaux, pas une interface utilisateur                                           |
| Tableau 10 000 lignes / 50 propriétés                               | [8 scénarios fonctionnels](evidence/session-6a-table-functional.txt) : owner/guest, filtres peu sélectifs, curseur profond, dix filtres ET, tri descendant/vides, valeurs masquées ; [banc refusé](evidence/session-6a-table-ram-refused.txt) avant le premier échantillon | **Aucun p95** ; AST de filtres, curseurs signés, API et pagination générale restent en 6b |
| Contrôle complet                                                    | [pnpm check](evidence/session-6a-final-check.txt), hooks/lint/types/Nest et 136 tests réussis, 6 SQL ignorés puis réussis séparément                                                                                                                                       | Les suites d’intégration ci-dessus sont distinctes de Vitest                              |

R12/S5-R11 restent obligatoires pour toute nouvelle route/extension de route, référence et portée de cache. Aucun statut « sécurisé » déduit de ces seuls appels au noyau. Restent notamment la qualification finale tableau/cellules, les courses et attaques des tickets natifs de lignes avant ouverture, le cache base/ligne en 6c et la comparaison alternée finale en 6d. Pas d’acceptation nouvelle de risque.

## Guide manuel à deux clients (10–15 minutes)

Prérequis : branche courante, `.env` local, `pnpm install`, `pnpm hooks:install`, PostgreSQL démarré (`docker compose up -d postgres`). Aucun compte/donnée de travail n’est modifié ; le lanceur crée un schéma aléatoire réservé aux tests. Il refuse un hôte PostgreSQL non local et `NODE_ENV=production`. Ce sont des clients du noyau de preuve ; l’ouverture du corps Yjs est éprouvée par le banc WSS, pas une nouvelle interface de ligne.

1. Terminal de fixture : `pnpm proof:databases serve`. Garder ce terminal ouvert. Ouvrir deux autres terminaux à la racine du dépôt, A (owner) et B (guest edit).
2. A : `pnpm proof:databases owner read text`. B : `pnpm proof:databases guest read text`. Les deux voient `version: "0"`, valeur vide.
3. A : `pnpm proof:databases owner write text 0 "Texte A"`. B : `pnpm proof:databases guest write number 0 42`. Les deux réussissent à version 1, bien qu’il s’agisse de la même ligne.
4. B : `pnpm proof:databases guest write text 0 "Texte B"`. Attendre **409 CELL_VERSION_CONFLICT**, avec valeur A/version 1 ; pas d’écrasement. Relire puis `guest write text 1 "Texte B"` : version 2.
5. A : `pnpm proof:databases owner write text 2 ""`. La valeur devient vide à version 3. Une écriture B à version 0 reste refusée : le vide n’a pas perdu sa version.
6. Terminal A : `pnpm proof:databases grant read`. B peut lire, mais `guest write number 1 43` est refusé **404 ACCESS_DENIED**. `grant none` refuse aussi la lecture, sans valeur courante dans l’erreur. A conserve son accès. `grant edit` permet de reprendre avec les bonnes versions.
7. Fermer les clients puis Entrée dans le terminal de fixture : suppression du seul schéma de test et du contexte `.local/session-6a-manual.json`. En cas de crash, ne pas réutiliser un contexte ancien ; son schéma est explicitement identifiable par ce fichier.
8. Exécuter les courses déterministes : `pnpm test:collab:e2e --suite database-cells`, puis `--suite reconciliation-random` et `--suite reconciliation-tree`. Le premier suspend réellement des transactions et observe les verrous, dans les deux ordres révocation/écriture. Les journaux doivent finir à zéro échec.

Reproduction des mesures **différée jusqu’à ≥3 Gio après préparation** : secteur (`BatteryStatus=2`), aucun autre test/build, trois séries. Arborescence : `$env:MEMORIA_MEASURE_DATABASE_TREE='true'; pnpm test:collab:e2e --suite databases-barriers; Remove-Item Env:MEMORIA_MEASURE_DATABASE_TREE`. Cellules/WSS : `pnpm test:collab:e2e --suite database-cells-load` (Caddy démarré). Tableau : `pnpm test:collab:e2e --suite database-table-load`. Le mode `MEMORIA_DATABASE_TABLE_SMOKE=true` exécute uniquement les assertions des requêtes, **sans chronomètre, rapport ni validation de latence** ; il ne remplace jamais le banc.

Ce qui pourrait casser : omission d’un sous-arbre dans une transaction composée, ordre de verrous inverse, réintroduction d’un ID masqué dans une future façade, mélange d’anciens writers avec les nouvelles migrations. Oracle, courses et erreurs génériques couvrent les mécanismes actuels ; l’intégration des futures routes et le déploiement coordonné restent à vérifier avant clôture.
