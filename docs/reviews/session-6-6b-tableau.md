# Session 6b — premier contrôle bloquant : tableau HTTP

27 octobre 2026. Travail sur `codex/session-6-databases`, après validation de 6a. **Livraison intermédiaire, 6b non terminée.** Le développeur exige de mesurer la vraie lecture HTTP dès son existence, avant de poursuivre CRUD, recherche, événements et tickets/cache de lignes. Aucun résultat de performance n'est déduit des tests fonctionnels ci-dessous.

**Socle, décision du développeur le 27 octobre :** Windows bloque désormais le binaire Turbo par sa politique de contrôle d'application. `typecheck` utilise `pnpm -r --if-present typecheck`, avec les mêmes douze packages et contrôles TypeScript. Le hook pre-push appelle cette commande via un lanceur Node ; tests de refus de commit/push conservés et adaptés. Aucun hook désactivé ni politique Windows modifiée. Les autres usages de Turbo (dev/build/start) ne sont pas remplacés dans ce correctif limité.

## Route réellement ajoutée et quotas

`POST /api/internal/workspaces/:workspaceId/databases/:databaseId/query`, réponse 200. Guard global, session injectée, email vérifié et assurance de contenu, Origin exact, politique et droits courants. Corps AST Zod strict ≤16 Kio ; deux tris, dix filtres ET, pagination 50/max 100 selon configuration. SQL paramétré, propriétés/identifiants/opérateurs de liste fermée. Les UUID de propriétés sont validés contre les définitions actives de cette base.

Famille L commune : **6 000/min/IP, 120/min/compte tous workspaces**, fenêtres SQL atomiques inchangées par un refus ; clés HMAC sans email, IPv6 /64, chaîne de proxy de confiance. Aucun budget multiplié par base ou gabarit. Admission commune à l'instance : **16 requêtes actives / 32 en attente** par défaut, attente bornée à deux secondes ; aucun second pool SQL. Timeout de chaque commande SQL à deux secondes. Réponse ≤4 Mio, réduction du nombre de lignes retournées et curseur sur la dernière réellement incluse.

Les barrières partagées des bases source/cibles sont prises dans l'ordre UUID, puis les définitions et les accès sont relus. Les références personne/relation sont filtrées aussi dans les prédicats vide/non vide et les réponses. Une valeur cachée ne fournit ni ID ni nombre, seulement `hasHidden`. Dernier contrôle de session/politique/droits avant commit. Le curseur HMAC est lié à acteur/session, workspace/base, version de schéma, époque d'accès et requête ; expiration technique de quinze minutes, erreur 409 demandant de reprendre la navigation.

| Règle             | Tentative réelle contre cette route                                                                                                      | Résultat fonctionnel                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| D01, D02          | Pas de cookie, mauvaise origine, base absente/cachée, autre workspace, mauvaise méthode                                                  | Refus 401/403/404 sans donnée privée                                                                  |
| D06, D07 / S5-R11 | Chercher les IDs cachés dans la réponse, filtrer une relation/personne cachée ou inexistante, comparer les erreurs, tester vide/non vide | Aucune fuite d'ID/titre/nombre ; même erreur générique ; vides fondés sur les seules valeurs visibles |
| D08               | Injection dans champ/valeur, opérateur inconnu, AST excessive, nombre/date invalides, tri relation, dépassement de taille/pagination     | Refus 400/413 ; `%`, `_`, antislash et contenu HTML restent littéraux                                 |
| D09               | Curseur falsifié, autre acteur, filtres changés, schéma modifié, révocation puis réattribution                                           | Refus 409, ou 404 pendant la perte de droit ; aucun retour aux anciens droits                         |
| D01, D04          | Grâce expirée, session de récupération restreinte, session supprimée                                                                     | Aucun accès au tableau                                                                                |
| D12               | Budget compte atteint puis changement d'UUID et en-têtes `Forwarded`, `X-Forwarded-For`, `X-Memoria-Client-IP` forgés ; budget IP saturé | 429 avec Retry-After ; aucun déplacement de la fenêtre par les refus                                  |

Exécutable permanent : `node scripts/build-server.mjs api --database-table-e2e`, puis `node --env-file=.env apps/api/dist/database-table.e2e.mjs`. Six groupes d'attaques, sept tests avec le parent. Les budgets sont prépositionnés à leur frontière dans cette fixture fonctionnelle pour vérifier les requêtes suivantes réellement refusées. Aucun prépositionnement dans le benchmark. Tests unitaires séparés pour signature et admission (file pleine, erreur, expiration sans exécution tardive).

Ces tests ne qualifient pas les futures routes CRUD/cellules, les nouvelles portées de cache/tickets, la charge à cinquante comptes, le déploiement derrière Caddy ni la saturation globale. La route de test est atteinte directement en HTTP local, avec une source non reconnue comme proxy ; la chaîne de confiance conserve le mécanisme de production. Les tests de création atomique, outbox et recherche sont encore absents de 6b. R12/S5-R11 restent applicables à chacune de ces futures routes avant ouverture.

## Protocole du contrôle HTTP

Commande : `node scripts/build-server.mjs api --database-table-load`, puis `node --env-file=.env apps/api/dist/database-table-load.mjs`. La compilation finit avant préparation. Secteur obligatoire, Windows ≥3 Gio avant préparation, Windows ≥1,5 Gio et WSL MemAvailable ≥2 Gio après préparation, zéro swap pendant chaque série, trois séries par cas. Traces conservées par `measurement-memory.mjs`, sans build ni autre test parallèle.

Même contenu 6a : 10 000 lignes, 50 propriétés, neuf types, options et ensembles aux bornes, quatre scénarios owner puis guest. **Douze comptes par rôle** sont ajoutés aux memberships de la fixture et alternent derrière une seule IP pour respecter les quotas. Aucun plafond de quota augmenté, aucune ligne de compteur effacée pendant la campagne. Tous les échantillons traversent la vraie route, le guard, les quotas, l'admission, le compilateur général, l'hydratation et la sérialisation. Relevé serveur depuis le premier middleware jusqu'à la fin de réponse, plus aller-retour HTTP complet. 200 échantillons par série, trois échauffements séparés ; p95 et médiane des trois publiés. Arrêt si une médiane serveur atteint 200 ms, sans optimisation ni poursuite du reste de 6b.

Pagination profonde : ancrage identique à 6a (`OFFSET 9000`), provisionné hors mesure dans la fixture avec le codec de signature serveur et le contexte propre à chaque compte. Chaque requête chronométrée vérifie réellement ce curseur et consomme les quotas. La navigation HTTP de page en page est testée séparément ; aucune chaîne de 180 pages consécutives n'est prétendue mesurée.

Visibilité personne : les douze vrais invités voient exactement l'ensemble visible par l'invité synthétique de 6a. Son ancienne auto-affectation est ajoutée à la liste assignable de cette fixture, en plus de la personne déjà assignable ; les nouveaux invités ne sont pas affectés aux lignes. Cela conserve la sélectivité du filtre personne et le contenu visible malgré le remplacement du compte de test par douze sessions HTTP réelles.

Avant chaque cas, le compilateur doit retourner les mêmes IDs ordonnés que l'oracle SQL fermé de 6a, sur la même fixture. Les deux `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` sont conservés hors chronométrage ; aucune branche du compilateur ne reconnaît les scénarios du benchmark. La fixture/oracle de `apps/api/src/testing/database-table-fixture.ts` est extraite du banc accepté `850162f`, sans changement de ses requêtes de sélection/hydratation.

## Fichiers prioritaires et test manuel

Lire `modules/databases/table-compiler.ts` (paramètres, sémantique et curseurs), `databases.service.ts` (droits, barrières et réponse), `database-quota.ts` et le guard, puis `database-table.e2e.ts` et `database-table-load.ts` dans `apps/api/src/`. Contrat dans `packages/contracts/src/databases.ts`.

Le parcours à deux clients de 6a reste le moyen manuel de créer une fixture isolée ; aucune interface de base n'est livrée. Pour cette tranche, lancer les attaques ci-dessus avec PostgreSQL local puis vérifier zéro échec et l'absence d'identifiant caché dans les assertions. Pour la performance, utiliser uniquement la commande dédiée avec les préconditions mémoire/secteur ; une suite d'attaque ne mesure pas la latence. Un guide CRUD/recherche/outbox complet sera fourni après la livraison de ces chemins.

Ce qui pourrait casser : coût du compilateur général et des contrôles supplémentaires, mauvais ordre des NULL en pagination, omission d'un droit dans la projection des références, reprise d'un curseur périmé, attentes au pool SQL sous charge. L'équivalence des résultats, les plans, les attaques et la mesure HTTP sont les contrôles de cette première tranche ; ils ne remplacent pas la revue finale 6d.

## Résultat du contrôle, 27 octobre 2026

Candidate mesurée : `8e151f77841ec6a6ec0cdcc9b3ddceb88d7b5cdc`. **Les huit scénarios HTTP passent ; le contrôle préalable autorise la suite de 6b.** Trois séries de 200 requêtes, aucun build/test parallèle, 24 traces valides et 615 intervalles vmstat sans swap. Windows : 3,426 Gio avant préparation ; minima des relevés de séries 1,687 Gio Windows et 5,077 Gio WSL. BatteryStatus=2 partout. Aucun rejeu ni série retirée.

| p95 serveur (ms)    | Série 1 | Série 2 | Série 3 |    Médiane |
| ------------------- | ------: | ------: | ------: | ---------: |
| owner — broad       |   63.97 |   65.69 |   67.49 |  **65.69** |
| owner — deep        |   52.26 |   53.27 |   52.39 |  **52.39** |
| owner — ten-filters |  157.60 |  163.50 |  155.73 | **157.60** |
| owner — nulls-desc  |   65.90 |   68.94 |   64.45 |  **65.90** |
| guest — broad       |   53.20 |   51.80 |   50.94 |  **51.80** |
| guest — deep        |   50.50 |   48.65 |   60.26 |  **50.50** |
| guest — ten-filters |  139.16 |  136.25 |  135.31 | **136.25** |
| guest — nulls-desc  |   63.90 |   61.81 |   64.99 |  **63.90** |

Le pire médian HTTP serveur est **157,60 ms**, sous 200 ms ; les trois p95 de ce cas sont 157,60 / 163,50 / 155,73 ms. L'aller-retour HTTP correspondant vaut 170,92 / 172,07 / 171,96 ms. Les huit comparaisons d'IDs ordonnés avec l'oracle fermé réussissent. Cette campagne séquentielle ne qualifie pas cinquante rédacteurs simultanés, toutes les distributions de données ou une pile derrière Caddy.

[Journal complet](evidence/session-6b-table-http/measurement.txt), [échantillons et plans bruts](evidence/session-6b-table-http/measurement.json), [index des traces](evidence/session-6b-table-http/index.json), [synthèse des plans](evidence/session-6b-table-http/plans-summary.json). Les chemins .local des sources désignent leur provenance ; les copies versionnées portent le même nom.

### Comparaison des plans

Les plans sont capturés hors chronométrage, sur la même fixture, dans l'ordre oracle puis compilateur. Leurs temps d'exécution sont des observations individuelles, **pas des p95 ni une comparaison alternée**. Le plan général réutilise les jointures scalaires et transmet les IDs d'options déjà validés par le service ; l'oracle fait une sous-requête d'options. Au cas dix filtres owner, cela donne 22 174 blocs touchés contre 226 736, et une sélection observée à 31,38 ms contre 91,03 ms. Invité : 19 972 contre 224 580 blocs, 19,46 contre 87,16 ms. Les contrôles d'options/droits en amont et l'hydratation restent inclus dans les p95 HTTP, pas dans ces seuls plans de sélection.

Pour les cas peu sélectif/profond, le plan général exploite l'index numérique et un tri incrémental, alors que l'oracle emploie selon le cas des scans plus larges et un tri. Pour le descendant avec vides, les deux ont la même forme : scans des index texte/numérique, scans des lignes/pages et tri (608 blocs touchés chacun). Aucun index ajouté ni optimisation postérieure à la mesure. Les UUID synthétiques/statistiques expliquent pourquoi une forme de plan isolée n'est pas une garantie pour toutes les bases.

Contrôles fonctionnels conservés : [pnpm check complet](evidence/session-6b-table-http/check.txt), 149 tests réussis / 6 SQL ignorés dans la suite standard ; [attaques réelles de cette route](evidence/session-6b-table-http/attacks.txt), 7 tests réussis. Le remplacement autorisé de Turbo conserve les douze typechecks et les refus réels de commit/push en cas d'échec.
