# Session 4 — étape 1 : cadrage

25 octobre 2026. Branche `codex/session-4-strong-auth`, créée depuis main `0b8c0f03ca44c9e0b3e233b91ba27fcf4db10e41`. La [PR 3d #4](https://github.com/FoxTimew/Memoria/pull/4) a été créée et fusionnée après autorisation explicite du développeur. **Aucun code applicatif de session 4 livré ici** : pas de migration, nouvelle route, dépendance ni écran. Seuls les documents et lanceurs de mesure changent.

## Fichiers à lire en priorité

1. [ADR 004](../adr/004-connexion-forte.md) : ce que permet chaque session, codes de secours, perte de facteur et cache partagé. Trois choix validés : codes communs TOTP/passkeys limités à la récupération ; reset opérateur ciblé, total explicite ; case « Poste partagé » décochée, cache workspace autorisé sauf interdiction administrateur.
2. [ADR 003](../adr/003-better-auth.md) : comment la preuve forte sera liée à la vraie session. Les options UV ne suffisent pas dans la version installée ; preuve serveur prévue en 4a.
3. [ADR 015](../adr/015-authentification-simple-et-workspaces.md) : reset email, propositions de quotas NAT et délais par compte. Les chiffres proposés ne sont pas encore appliqués.
4. [ARCHITECTURE.md](../../ARCHITECTURE.md#session-4--découpage-proposé-après-ce-cadrage) : 4a facteurs/assurance, 4b politique/actions, 4c récupération, 4d quotas, 4e cache ; chaque livraison sera poussée et relue séparément, avec son guide manuel. L'étape actuelle s'arrête avant 4a.
5. [Sonde d'alimentation](../../scripts/measurement-power.mjs), [tests de sonde](../../scripts/measurement-power.test.mjs) et [tests du lanceur](../../scripts/measurement-runner.test.mjs), puis lanceurs [courant](../../scripts/measure-collab.mjs), [alterné](../../scripts/compare-collab.mjs) et [direct](../../scripts/test-collab.mjs).

## Ce qui pourrait casser

- Une sonde absente ou un BatteryStatus autre que 2 empêche désormais une mesure, même si Windows affiche une batterie pleine. Les tests fonctionnels restent accessibles ; les suites de mesure demandent le secteur. Un serveur sans Win32_Battery nécessitera une adaptation documentée avant qualification.
- Les campagnes anciennes ne peuvent pas être reprises sous un nouveau protocole. Un refus après compilation conserve son journal ; il faut une nouvelle campagne pour ne pas l'écraser.
- En session 4, la difficulté est de ne jamais confondre enrôlement, récupération et connexion forte. Les erreurs entre création de session et écriture d'assurance doivent laisser l'accès fermé.
- Les délais par compte doivent freiner les essais parallèles sans laisser un attaquant prolonger l'attente de la victime. Cette preuve est explicitement bloquante en 4d ; le choix de file/concurrence n'est pas prétendu résolu par le cadrage.
- Une interdiction distante de cache ne peut pas effacer un navigateur hors ligne. Il faut empêcher toute résurrection à sa reprise ; le mode partagé doit prévenir de la perte des changements en mémoire à la fermeture.

## Comment relire et tester cette étape

1. Lire les trois ADR et le tableau 4a–4e ; vérifier que les choix validés et les valeurs encore proposées sont distincts. Les guides des futures fiches figurent dans ce tableau ; les parcours forts ne sont pas encore exécutables.
2. Dans un terminal du dépôt, lancer `node scripts/measurement-power.mjs`. C'est une lecture seule, sans benchmark ni accès PostgreSQL. Sur cette machine, le relevé réel du 25 octobre à 06:39 UTC indique BatteryStatus 2, charge 100 %, sortie 0 ; journal `.local/session-4-power-preflight.log`.
3. Pour tester manuellement le refus, débrancher le portable puis relancer **seulement cette sonde** : attendu statut différent de 2, sortie 3 et demande de branchement. Rebrancher ensuite. Le débranchement physique n'a pas été réalisé par l'agent ; les statuts négatifs et erreurs sont couverts par simulation unitaire.
4. Lancer `pnpm exec vitest run scripts/measurement-power.test.mjs scripts/measurement-runner.test.mjs` pour les cas 2, batterie déchargée, pleine, en charge, relevé manquant/erroné, batteries multiples et changement entre deux relevés. Le lanceur réel est aussi importé avec une sonde et un compilateur simulés : les trois suites refusent avant compilation ; une déconnexion après compilation empêche le lancement de la série. Aucun cas n'effectue de benchmark.
5. Lancer `pnpm check`. Le compte rendu des contrôles ci-dessous doit renvoyer au journal complet, résumé Vitest et code final compris. Ne pas utiliser `--no-verify` pour pousser.

## Preuves et limites de cette livraison

| Sujet        | Preuve réelle dans cette étape                                                                  | Pas encore prouvé                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Git          | PR #4 fusionnée, main avancé en fast-forward, nouvelle branche depuis son commit                | Aucun merge de session 4 demandé                                                  |
| Alimentation | Relevé Windows réel et tests unitaires des états/refus ; branchement des trois lanceurs relu    | Débranchement physique, nouvelle campagne de performance, hôte sans sonde Windows |
| Better Auth  | Lecture du code installé 1.7.12 et des points d'intégration ; ADR explicitent les tests à faire | UV, TOTP, codes communs, reset, assurance et quotas nouveaux en fonctionnement    |
| Cache        | Contrat et parcours de purge/reprise définis à partir des mécanismes 3c                         | Option partagée et politique workspace actives                                    |

Contrôles exécutés : **`pnpm check` réussi, sortie 0** ; lint/format, typecheck des 12 packages (cache Turbo), preuve Nest compilée et Vitest **108 réussis, 6 ignorés**, soit 21 fichiers réussis et un ignoré. Les 6 tests SQL demandent `TEST_DATABASE_URL` et ne sont pas présentés comme exécutés. Les 16 tests ajoutés vérifient la sonde et le refus du lanceur. Journal complet : [session-4-cadrage-check.txt](evidence/session-4-cadrage-check.txt), copie de `.local/session-4-cadrage-check.log`, résumé final et code de sortie compris. Relevé matériel : [session-4-power-preflight.txt](evidence/session-4-power-preflight.txt).

Les suites e2e SQL/HTTPS/WebSocket et les mesures 3d ne sont pas relancées pour ce changement de documents et de lanceurs ; aucun code sous `apps/` ou `packages/` n'a changé. Aucun résultat historique n'est réétiqueté. La qualification dédiée 4 vCPU / 8 Gio avec cinquante comptes reste obligatoire avant les utilisateurs réels.
