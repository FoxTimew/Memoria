# Suite de 4f — diagnostic SQL, optimisation et décisions

Décisions du développeur du **25 octobre 2026**, sur `codex/session-4-strong-auth`. Les acceptations limitées au MVP auto-hébergé et les prérequis sont consignés dans la [matrice](session-4-4f-matrice.md). R15 reste suspendu jusqu'à la comparaison finale ; le diagnostic a été présenté au développeur avant toute modification des fonctions de production.

## Diagnostic avant optimisation

`node scripts/profile-collab-access.mjs baseline` utilise la requête `resolveAccess` réelle, PostgreSQL 17, ses migrations et un schéma jetable avec session forte/passkey vivante et politique obligatoire. La fixture n'effectue pas de cérémonie WebAuthn : seul le contrôle SQL est mesuré. Chaque série vérifie secteur et RAM libre après compilation et création du schéma. Trois séries, 20 appels de chauffe puis 200 échantillons par cas ; aucun autre test ou build simultané.

Le plan préparé devient générique après cinq plans personnalisés. `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` et `auto_explain` avec instructions imbriquées sont activés seulement pour l'inspection, puis désactivés avant les échantillons chronométrés. Les compteurs de fonctions et de lectures sont des **deltas avant/après** les 200 appels, dans la même transaction. La première exploration utilisait des valeurs cumulées incluant parfois la chauffe ; ses journaux sont conservés sous `preliminary` mais ne servent pas aux nombres de lectures ci-dessous.

| Mesure                   | Trois p95, ms         | Médiane des p95 |
| ------------------------ | --------------------- | --------------- |
| Requête complète         | 5,091 / 5,240 / 5,110 | **5,110 ms**    |
| Fonction forte seule     | 1,486 / 1,530 / 1,563 | **1,530 ms**    |
| Fonction contenu seule   | 3,052 / 3,106 / 2,970 | **3,052 ms**    |
| Fonction workspace seule | 4,463 / 4,423 / 4,331 | **4,423 ms**    |

Ces p95 comprennent l'aller-retour local Node/PostgreSQL. Les statistiques serveur attribuent en moyenne **3,30 ms** à la fonction workspace par appel du resolver, fonctions imbriquées comprises. Ne pas additionner les temps inclusifs des fonctions.

Par autorisation de cette fixture : trois appels `auth_session_is_strong`, six recherches `auth_sessions`, quatre `session_assurance`, deux `workspace_members`, trois scans d'une ligne `auth_passkeys`. Le plan principal a 89 blocs partagés déjà présents et zéro lecture disque dans la première série. La duplication est confirmée par les plans imbriqués : deux vérifications fortes depuis le contenu, une depuis le workspace. Le diagnostic indique un coût de préparation/exécution de fonctions imbriquées, pas un index absent ni une contention observée dans cette fixture. Les plans instrumentés sont conservés sans les comparer aux p95 non instrumentés.

## Modification limitée

La [migration 0016](../../packages/db/drizzle/0016_cached_auth_access_plans.sql) remplace le langage des trois fonctions par PL/pgSQL et conserve exactement leurs expressions, paramètres et volatilité STABLE. Le moteur réutilise les plans préparés internes, comme décrit par [PostgreSQL](https://www.postgresql.org/docs/17/plpgsql-implementation.html#PLPGSQL-PLAN-CACHING). Il continue à lire les données à chaque appel : aucune autorisation ou durée de grâce n'est mise en cache. La requête du resolver, les verrous de page, triggers de révocation, assurances et politiques sont inchangés. Pas de nouvel index ni de modification des données métier.

Après optimisation, les trois p95 du resolver sont **2,376 / 2,022 / 2,164 ms**, médiane **2,164 ms**. Le temps serveur de la fonction workspace est **0,746 / 0,779 / 0,807 ms par appel** en moyenne. Les nombres de lectures et d'appels restent identiques. Ce choix conserve les redondances de contrôle et supprime leur coût de préparation répété ; il ne cherche pas à simplifier les règles de sécurité.

Sources méthodologiques : [auto_explain](https://www.postgresql.org/docs/17/auto-explain.html), [statistiques transactionnelles](https://www.postgresql.org/docs/17/monitoring-stats.html). L'instrumentation a un coût ; ses plans sont diagnostiques et restent séparés des mesures de validation + journal.

## Preuves de sécurité

[Suite SQL dédiée](../../apps/collab/src/testing/access-security.e2e.ts) : **20 tests réussis**, parent compris. Dix-huit situations confrontent les fonctions livrées à leurs versions originales tirées des migrations et à des attentes explicites : session expirée/supprimée, email non vérifié, preuve future, génération révoquée, récupération, facteur étranger, TOTP vérifié/non vérifié, grâce valide/expirée, obligation désactivée, appartenance retirée, workspace/page archivés. Les plans sont chauffés et les autorisations relues après chaque changement et restauration.

Une course réelle fait attendre l'écriture derrière le verrou de page pris par une révocation de génération. Après COMMIT de la révocation, l'update échoue `ACCESS_DENIED`, sans nouvelle révision. La présence de l'attente est vérifiée avec `pg_blocking_pids`, pas déduite d'un simple délai. Les suites HTTP/WS existantes et adverses doivent aussi passer avant la comparaison finale.

## Règle de mesure et résultat final

La règle retenue est `candidate − référence ≤ max(0,10 × référence, 2 ms)`, appliquée à chaque médiane des trois p95. Les plafonds absolus restent indépendants : contenu <50 ms, historique ≤100 ms, froid des deux profils <500 ms. Les deux lanceurs utilisent le même calcul et des tests couvrent ses limites. La nouvelle règle ne réétiquette pas l'échec archivé de la campagne initiale.

La comparaison alternée finale reste à exécuter après gel du commit applicatif et tests complets. Elle inclura tous les correctifs 4f et la migration 0016, avec main figé, trois paires AB/BA/AB, `BatteryStatus=2` et au moins 3 Gio libres avant chaque série. Un dépassement après cette optimisation arrête la suite et est soumis au développeur sans nouvelle optimisation implicite.

## Relecture et essai manuel

Lire en priorité la migration 0016, la suite SQL dédiée, les fonctions de seuil dans `scripts/measurement-regression.mjs`, puis les preuves archivées et la matrice de risques. Le risque principal est une différence de résolution de paramètres/plan entre SQL et PL/pgSQL ; les expressions inchangées et le test comparatif bornent ce risque, sans prétendre tester toutes les tailles de base ou toutes les charges.

Sur la pile locale, appliquer `pnpm db:migrate`, puis suivre le guide manuel 4f pour connexion forte, politique et récupération. Avec une page ouverte dans un second navigateur, retirer le facteur ou imposer la politique à un compte non conforme : l'accès doit être coupé et la reprise refusée. Cette optimisation ne modifie aucun écran. Les essais de crash R09, charge studio R11, rétention/anonymisation R13 et cache après grâce R14 restent des travaux de qualification avant utilisateurs réels.
