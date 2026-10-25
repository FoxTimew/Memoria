# Suite de 4f — diagnostic SQL, optimisation et décisions

Décisions du développeur du **25 octobre 2026**, sur `codex/session-4-strong-auth`. Les acceptations limitées au MVP auto-hébergé et les prérequis sont consignés dans la [matrice](session-4-4f-matrice.md). La comparaison finale satisfait la nouvelle règle et les plafonds absolus : aucune dérogation R15 n'est nécessaire. Le diagnostic a été présenté au développeur avant toute modification des fonctions de production.

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

Une course réelle fait attendre l'écriture derrière le verrou de page pris par une révocation de génération. Après COMMIT de la révocation, l'update échoue `ACCESS_DENIED`, sans nouvelle révision. La présence de l'attente est vérifiée avec `pg_blocking_pids`, pas déduite d'un simple délai. Les suites HTTP/WS existantes et adverses ont aussi été relancées avec la migration avant la comparaison finale.

| Contrôle sur la version optimisée                               | Résultat et journal complet                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                                                    | **117 tests Vitest réussis**, 6 SQL ignorés ici ; lint, types et bootstrap réussis — [journal](evidence/session-4f-sql/check.txt)                                                                                                                                                                                                                 |
| `pnpm test:db` et `pnpm build`                                  | 6 tests SQL réussis et quatre applications compilées — [SQL](evidence/session-4f-sql/db.txt), [build](evidence/session-4f-sql/build.txt)                                                                                                                                                                                                          |
| Équivalence des fonctions et révocation pendant l'attente       | **20 tests réussis** — [access-security](evidence/session-4f-sql/access-security.txt)                                                                                                                                                                                                                                                             |
| Facteurs / politique / récupération / quotas / cache / attaques | 14 / 13 / 13 / 12 / 7 / 9 tests réussis — [facteurs](evidence/session-4f-sql/strong.txt), [politique](evidence/session-4f-sql/workspace.txt), [récupération](evidence/session-4f-sql/recovery.txt), [quotas](evidence/session-4f-sql/limits.txt), [cache](evidence/session-4f-sql/cache.txt), [attaques](evidence/session-4f-sql/adversarial.txt) |
| Pages / transport / révocations HTTP→WebSocket                  | 8 / 13 / 1 tests réussis — [pages](evidence/session-4f-sql/pages.txt), [transport](evidence/session-4f-sql/transport.txt), [révocations](evidence/session-4f-sql/revocations.txt)                                                                                                                                                                 |
| Quatre parcours HTTPS Caddy/Edge                                | Un test chacun : [facteurs/QR/UV/politique](evidence/session-4f-sql/strong-browser.txt), [récupération](evidence/session-4f-sql/recovery-browser.txt), [cache à trois onglets](evidence/session-4f-sql/cache-browser.txt), [attaques](evidence/session-4f-sql/adversarial-browser.txt)                                                            |
| Migration locale puis second lancement                          | Deux sorties 0 — [migration](evidence/session-4f-sql/migration.txt), [répétition](evidence/session-4f-sql/migration-repeat.txt)                                                                                                                                                                                                                   |

Les scénarios HTTPS emploient un authentificateur virtuel UV. Les essais Android, Windows Hello et YubiKey du développeur restent les validations matérielles de 4a–4e ; aucun nouvel essai matériel n'est revendiqué ici. Les nombres Node incluent leurs tests parents. Le parcours navigateur des délais, l'authentification initiale, la présence et l'admission ont leurs preuves dans la livraison 4f initiale ; ils ne sont pas présentés comme relancés dans cette optimisation.

Après archivage des résultats, le [contrôle final `pnpm check`](evidence/session-4f-sql/final-check.txt) passe également : 117 tests réussis, sortie 0. Les [sondes HTTPS après redémarrage](evidence/session-4f-sql/health.txt) renvoient 200 pour API, collab, worker et écran de connexion.

## Règle de mesure et résultat final

La règle retenue est `candidate − référence ≤ max(0,10 × référence, 2 ms)`, appliquée à chaque médiane des trois p95. Les plafonds absolus restent indépendants : contenu <50 ms, historique ≤100 ms, froid des deux profils <500 ms. Les deux lanceurs utilisent le même calcul et des tests couvrent ses limites. La nouvelle règle ne réétiquette pas l'échec archivé de la campagne initiale.

Comparaison du **25 octobre 2026** entre main `0b8c0f03ca44c9e0b3e233b91ba27fcf4db10e41` et le commit applicatif final `f45113b2c7774f4ce2361b934f161427d2801f00`, incluant les correctifs 4f et la migration 0016. Trois paires AB/BA/AB, sources/packages/migrations propres à chaque commit, mêmes fixtures encodées, aucun échantillon écarté. Candidate préparée avec assurance forte vivante et obligation workspace, cérémonie cryptographique hors mesure. Le commit suivant n'ajoute que documentation et preuves, sans modifier le code mesuré.

Portable Windows, Ryzen 7 5800H, Node 24.21.0 ; **BatteryStatus=2** avant chacune des douze séries, RAM libre **3,965 à 4,058 Gio**. Aucun build ou autre test simultané. Les services locaux API/web/collab/worker ont été arrêtés pendant la campagne puis redémarrés.

| Mesure, profil 1 Mio | Trois p95 main, ms          | Trois p95 candidate, ms     | Médianes main → candidate | Écart                | Hausse maximale autorisée |
| -------------------- | --------------------------- | --------------------------- | ------------------------- | -------------------- | ------------------------- |
| Update contenu       | 7,799 / 7,584 / 7,875       | 8,801 / 8,761 / 8,638       | **7,799 → 8,761 ms**      | +0,962 ms (+12,33 %) | 2,000 ms                  |
| Update historique    | 34,581 / 32,597 / 32,518    | 32,967 / 33,399 / 32,896    | **32,597 → 32,967 ms**    | +0,370 ms (+1,14 %)  | 3,260 ms                  |
| Froid contenu        | 148,710 / 144,403 / 149,091 | 144,232 / 145,978 / 147,880 | **148,710 → 145,978 ms**  | −2,732 ms (−1,84 %)  | 14,871 ms                 |
| Froid historique     | 243,107 / 243,876 / 238,774 | 247,252 / 267,056 / 245,271 | **243,107 → 247,252 ms**  | +4,146 ms (+1,71 %)  | 24,311 ms                 |

**Les quatre mesures passent, sortie 0.** Le contenu dépasse 10 % mais augmente de moins de 2 ms : c'est l'application de la règle explicitement décidée, pas une dérogation. Les plafonds absolus passent aussi. Ce résultat local n'établit ni la capacité d'un studio de cinquante personnes ni la qualification sur 4 vCPU / 8 Gio.

Preuves : [résumé](evidence/session-4f-sql-performance/summary.json), [manifest des douze séries et empreintes](evidence/session-4f-sql-performance/manifest.json), [journal intégral](evidence/session-4f-sql-performance/complete.txt). Les douze rapports JSON contiennent les résultats et échantillons ; le protocole exact est archivé en `protocol-source.txt`, `power-source.txt`, `regression-source.txt`. Leur concaténation dans cet ordre a l'empreinte SHA-256 `6b4b1a047e48f08514979844c16039c41412a570be3369a212ffcec9e9fe1d55`.

Pour reproduire cette campagne (secteur et RAM requis) :

```powershell
node scripts/compare-collab.mjs --session4 --reference 0b8c0f03ca44c9e0b3e233b91ba27fcf4db10e41 --candidate f45113b2c7774f4ce2361b934f161427d2801f00
```

Le profilage ciblé et ses plans sont archivés séparément : [baseline](evidence/session-4f-sql/profile-baseline.txt), [optimisé](evidence/session-4f-sql/profile-optimized.txt) et fichiers `baseline-{1,2,3}.json` / `optimized-{1,2,3}.json`. `node scripts/profile-collab-access.mjs <label>` mesure les migrations du checkout courant ; son label ne sélectionne pas une ancienne version. La baseline a été produite avant ajout de la migration 0016.

## Relecture et essai manuel

Lire en priorité la migration 0016, la suite SQL dédiée, les fonctions de seuil dans `scripts/measurement-regression.mjs`, puis les preuves archivées et la matrice de risques. Le risque principal est une différence de résolution de paramètres/plan entre SQL et PL/pgSQL ; les expressions inchangées et le test comparatif bornent ce risque, sans prétendre tester toutes les tailles de base ou toutes les charges.

Sur la pile locale, appliquer `pnpm db:migrate`, puis suivre le guide manuel 4f pour connexion forte, politique et récupération. Avec une page ouverte dans un second navigateur, retirer le facteur ou imposer la politique à un compte non conforme : l'accès doit être coupé et la reprise refusée. Cette optimisation ne modifie aucun écran. Les essais de crash R09, charge studio R11, rétention/anonymisation R13 et cache après grâce R14 restent des travaux de qualification avant utilisateurs réels.
