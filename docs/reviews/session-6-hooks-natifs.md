# Correction du socle — hooks Git natifs

26 octobre 2026, sur `codex/session-6-databases`. Extension explicitement autorisée du cadrage documentaire, **aucun code applicatif de bases** et aucun début de 6a.

## Problème et changement

Windows refuse `lefthook.exe` : événement CodeIntegrity 3077, politique `VerifiedAndReputableDesktop`, statut `0xc0e90002`. Smart App Control ne permet pas d'exception par application ([Microsoft](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)). La première demande d'autoriser seulement ce fichier n'était donc pas adaptée ; sa nouvelle exécution est restée bloquée. Aucun hook n'a été désactivé et aucune protection Windows n'a été modifiée.

Le développeur a autorisé son remplacement par des hooks Git natifs conservant les contrôles. Les fichiers `.githooks/pre-commit` et `pre-push` invoquent Node, puis `scripts/git-hooks.mjs`. Une erreur de commande, d'exécution, un signal ou une commande manquante refuse l'opération. Aucun chemin de contournement par variable d'environnement ou mode de test dans le lanceur. Git utilise le code de sortie non nul pour refuser commit/push ([documentation Git](https://git-scm.com/docs/githooks)).

| Hook       | Contrôles conservés                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pre-commit | `scripts/check-staged.mjs` sur l'index ; ESLint `--fix --max-warnings=0` sur JS/MJS/TS/TSX ajoutés/modifiés ; Prettier `--write --ignore-unknown` sur fichiers indexés ; réindexation des corrections |
| pre-push   | Turbo typecheck ; build de la preuve Nest ; exécution de la preuve ; Vitest `run --passWithNoTests`, comme avant                                                                                      |

Un second contrôle des secrets inspecte l'index après corrections. Les noms de fichiers sont transmis comme arguments, avec séparateur `--`, sans interpolation shell et par lots de taille bornée. Suppressions exclues des outils qui doivent lire un fichier. Les chemins non réguliers sont refusés avant correction.

**Protection des changements locaux :** lorsqu'un fichier indexé contient aussi des modifications non indexées, le hook refuse avant lint/formatage et demande de préparer le fichier complet souhaité. Il ne cache pas automatiquement le travail en cours et ne l'inclut pas silencieusement dans le commit. Cette restriction d'ergonomie est documentée ; aucun contrôle de qualité n'est retiré.

## Installation et fichiers prioritaires

Lire `scripts/git-hooks.mjs`, `scripts/install-git-hooks.mjs`, puis `scripts/git-hooks.test.mjs`. `package.json`, `pnpm-workspace.yaml` et le lockfile retirent Lefthook ; aucune autre version de dépendance n'est mise à jour. Les sources des deux hooks sont versionnées. L'installateur les copie en LF et exécutables dans le répertoire de hooks fourni par Git ; il ne change pas `core.hooksPath`.

Exécuter `pnpm install --frozen-lockfile`, puis **`pnpm hooks:install` dans chaque clone existant ou nouveau**. L'installation remplace uniquement les wrappers générés de Lefthook ou les hooks Memoria, refuse un hook personnalisé préexistant ou un `core.hooksPath` configuré, et conserve les autres hooks. Elle peut être relancée. La configuration Git locale change seulement par ces deux fichiers de hook, pas par une désactivation des contrôles. Sur une ancienne branche dépourvue du lanceur, le hook échoue explicitement ; réinstaller les hooks adaptés à cette branche après relecture.

## Ce qui est testé et limites

Douze scénarios permanents, exécutés par Vitest dans des dépôts Git temporaires isolés sous `.local/git-hook-tests`. Git, installation et wrappers sont réels ; aucune option `--no-verify` ni hook désactivé dans ces essais.

| Preuve                                                | Portée réelle                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret reconnaissable et chemin interdit              | Scanner réel ; commit refusé, HEAD inchangé, contenu du faux secret absent de la sortie                                                                                                                                            |
| Violation ESLint et JSON non formatable               | Vrais exécutables ESLint/Prettier ; commit refusé et HEAD inchangé                                                                                                                                                                 |
| Fichier partiellement indexé                          | Commit refusé ; index et contenu de travail restent distincts et inchangés                                                                                                                                                         |
| Formatage réussi et nom contenant syntaxe shell       | Corrections réellement committées ; fichier modifié mais non indexé non inclus                                                                                                                                                     |
| Échec typecheck / build / preuve / tests (quatre cas) | Chaque outil coûteux remplacé **dans le dépôt de test uniquement** par un programme renvoyant un échec ; vrai push refusé, référence distante inchangée, étapes suivantes non exécutées ; succès du push après retrait de la panne |
| Outil pre-push absent                                 | Push refusé, aucune branche créée sur le dépôt distant temporaire                                                                                                                                                                  |
| Installation/réinstallation et hooks personnalisés    | Migration des wrappers générés, installation idempotente, refus de modifier hook personnalisé ou core.hooksPath, autres hooks conservés                                                                                            |

Les substitutions de tests prouvent la propagation des échecs jusqu'à Git, pas la capacité intrinsèque de TypeScript ou Vitest à détecter tout défaut. `pnpm check` et le push final utilisent les **vrais outils du monorepo**. Tests exécutés sur Windows ; portabilité POSIX prévue par sh/Node et bits exécutables, sans prétendre à une exécution Linux/macOS. Les hooks locaux ne remplacent pas une CI ou des règles serveur : un développeur disposant du dépôt peut modifier ses hooks/configuration. Le scanner de secrets reste heuristique, comme avant.

Résultat des tests ciblés : **12 réussis**, journal `.local/session-6-hooks-tests.log`. Validation complète finale : **`pnpm check` code 0, 134 tests réussis / 6 SQL ignorés, 24 fichiers réussis / 1 ignoré**, lint/format, douze packages typés et preuve Nest réussis ; [journal complet](evidence/session-6-native-hooks-check.txt), résumé Vitest inclus. Aucun benchmark ni test de bases ; la revue fonctionnelle de session 6 reste à venir. Le push final réexécute typage, preuve et tests par le nouveau hook, sans contournement ; son résultat et le hash distant sont donnés dans le compte rendu de livraison.

## Guide manuel (environ cinq minutes)

1. Exécuter `pnpm hooks:install` ; constater les deux hooks installés et la conservation des autres hooks. Relancer : installation idempotente.
2. Exécuter `pnpm exec vitest run scripts/git-hooks.test.mjs`. Les douze essais créent leurs propres dépôts et remotes locaux ; aucun faux secret ou commit de test n'est ajouté au vrai dépôt, aucun push de test vers GitHub.
3. Lire le résumé ; il doit annoncer douze réussites. Le nettoyage ne supprime que les répertoires de fixture créés par cette suite.
4. Pour le travail courant, préparer les fichiers complets souhaités, lancer commit puis push normalement. Les lignes `[git hook]` montrent les étapes ; tout échec doit laisser l'opération bloquée. Ne pas utiliser `--no-verify` pour passer un échec.

Ce qui pourrait casser : Node absent du PATH de l'interface Git, dépendances non installées, installation non relancée après clone/migration, hook personnalisé nécessitant une intégration manuelle, fichier partiellement indexé ou retour à une ancienne branche. Tous doivent produire un échec visible ; aucune relance automatique sans contrôle.
