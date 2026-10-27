# Session 6c — tableau et pages de lignes

27 octobre 2026, branche `codex/session-6-databases`. L’interface utilise les services qualifiés en 6b. Aucune nouvelle route API, migration, modification du compilateur SQL ou augmentation des quotas. La revue adverse et les mesures 6d restent nécessaires avant merge.

## À lire en priorité

1. `apps/web/src/components/database-screen.tsx` : tableau paginé, lecture seule, schéma autorisé, corbeille, page collaborative de ligne et contrôle au réveil.
2. `database-cell.tsx`, `database-value.tsx`, `apps/web/src/lib/database-ui.ts` : les neuf types, versions par cellule, conflit avec saisie conservée et delta des références visibles.
3. `database-query.tsx`, `database-schema.tsx` : AST de filtres, vue commune, propriétés/options et liste assignable owner/admin.
4. `page-editor.tsx`, `page-title.tsx`, `collaboration-client.ts` : même éditeur pour les pages et lignes, ticket natif `database-row`, titre relationnel distinct du corps.
5. `cache-policy.ts`, `yjs-cache.ts`, `cache-policy-monitor.tsx` : ticket antérieur à la requête, contrôle frais des lignes, invalidation base/cycle de vie et tombstones de déconnexion.
6. `scripts/test-databases-browser.mjs`, puis le [guide à deux navigateurs](session-6-6c-guide-manuel.md).

## Comportement

Les bases accessibles ont leur lien tableau dans la barre latérale. Les lignes restent absentes de l’arbre ; un résultat de recherche ouvre la route native de ligne. Le tableau propose colonnes masquables, pagination 10/50/100 (soumise aux limites serveur du déploiement), deux tris et dix filtres ET. Les membres peuvent enregistrer la vue commune ; les invités ajustent uniquement leur affichage. Les filtres de personnes/relations ne portent que sur les valeurs accessibles, ceux de dates sur le début de période.

Chaque cellule se confirme séparément avec sa version. Zéro, faux et vide restent distincts ; les nombres gardent leur précision décimale. Les dates/heures utilisent ISO avec décalage et fuseau IANA. Les sélecteurs recherchent et paginent côté serveur. Une référence cachée donne une mention unique « Certaines valeurs ne sont pas accessibles », sans titre, identifiant ni nombre. Seuls les ajouts/retraits visibles sont envoyés, sans remplacer les liens cachés.

Un conflit recharge et affiche la valeur courante, conserve la saisie et exige un choix explicite avant réapplication. Une seconde course provoque un nouveau 409. L’invité en lecture n’a aucun bouton d’édition de cellule ; le titre et le corps de ligne sont aussi non modifiables. La gestion du schéma, des options, de la vue commune et de la corbeille est invisible au guest edit. Le serveur impose toujours les mêmes règles indépendamment du DOM.

Les propriétés ne sont jamais stockées dans IndexedDB. Le cache persiste le **corps Yjs**, par utilisateur/workspace/ligne/génération avec portée base/cycle de vie. Une décision fraîche précède la lecture des octets. Le moniteur d’un onglet visible contrôle aussi les lignes déjà stockées, par lots de 100 : révocation de base ⇒ ses lignes ; archivage ⇒ cette ligne. Les onglets cachés revérifient avant reprise. Cela évite de multiplier inutilement le quota de lecture par le nombre d’onglets en arrière-plan. Le tableau se relit toutes les quinze secondes et au retour au premier plan ; le moniteur du cache garde sa cadence de quatre secondes dans un onglet visible. Les contrôles/fermetures collaboratifs du serveur restent inchangés.

## Preuves exécutées

La suite navigateur utilise Next construit, NestJS, Better Auth, PostgreSQL, Hocuspocus et Caddy HTTPS/WSS réels, avec Edge et deux contextes de comptes. Seule l’appartenance guest initiale est une fixture SQL. Les partages passent par HTTP avec une preuve WebAuthn virtuelle réelle. Les données isolées du test sont supprimées ; aucune donnée du développeur n’est réinitialisée.

| Scénario                                             | Test permanent                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invité lecture, schéma invisible, références cachées | `test:databases:browser` : aucune cellule modifiable ni gestion de schéma ; aucun titre secret ; mention neutre                                                         |
| Prestataire met à jour le statut d’une tâche         | Même suite : « Terminé » choisi par le guest dans l’interface, puis relecture HTTP                                                                                      |
| Sélecteurs et conservation des liens cachés          | Même suite : guest voit son nom seulement, affectation owner cachée conservée ; relation non partagée conservée                                                         |
| Conflit de cellule                                   | Même suite : écriture concurrente réelle, valeur actuelle affichée, saisie intacte, réapplication explicite et relecture serveur                                        |
| Neuf types, requête et schéma                        | Même suite : texte, zéro, faux, date civile/période, URL, select/multiple, personne, relation ; filtre titre, tri descendant et création de colonne owner               |
| Pagination signée                                    | Même suite : 10+1 lignes, aller/retour, aucun identifiant répété                                                                                                        |
| Ligne collaborative                                  | Même suite : corps reçu dans l’autre navigateur via WSS, titre enregistré par la route native                                                                           |
| Hors ligne puis fermeture                            | Même suite : saisie persistée, fermeture/réouverture en ligne et fusion reçue dans l’autre navigateur                                                                   |
| Résurrection après retrait/réattribution             | Même suite : coupure, saisie, **vrai gel CDP avec timers arrêtés**, retrait HTTP, purge, réveil, réattribution lecture ; aucun ancien texte rejoué ; autre base intacte |
| Cycle de vie et déconnexion                          | Même suite : archivage/restauration, purge de ligne ; déconnexion confirmée ailleurs, réveil de l’onglet figé et cache utilisateur vide                                 |
| Pages ordinaires                                     | `test-shares-browser.mjs` : lecture seule, partage guidé, invalidation ciblée, déplacement, cache hors ligne/figé sans rejeu                                            |
| Contrats UI/cache                                    | `database-ui.test.ts` (7 scénarios), suites IndexedDB existantes, destination MFA locale limitée, recherche avec destination native                                     |

R12/S5-R11 : les routes gardées et quotas L/E/C/S/A/Content restent ceux de la [matrice 6b](session-6-6b-services.md#routes-et-matrice-des-quotas). Les deux nouvelles routes Next ne servent aucun contenu de workspace côté serveur ; elles utilisent ces API. Pas d’exception `@Public`. La matrice HTTP/WSS de 6b reste permanente et sera consolidée en 6d ; le formulaire n’est pas une frontière de sécurité.

Journaux complets dans [evidence/session-6c](evidence/session-6c/). `pnpm check` termine avec **165 tests réussis, 6 SQL ignorés dans cette commande** ; ces six sont lancés séparément par `pnpm test:db`. Chaque script navigateur a un scénario intégré et son résumé node:test, pas un test distinct par message PASS. Build Next réussi.

## Ce qui pourrait casser / non prouvé ici

- Le guide couvre manuellement les changements d’options/type, dates instantanées, vue commune et personnes assignables. Le navigateur automatisé crée une colonne mais ne couvre pas toutes les combinaisons de gestion ; les contrôles serveur sont ceux de 6b.
- Un schéma modifié invalide potentiellement filtres/curseurs. Actualiser et reprendre la première page. Un conflit de schéma garde le formulaire mais ne convertit pas une saisie dans un nouveau type : recopier celle-ci avant fermeture. Une colonne retirée n’a pas encore de panneau de restauration ; les options et lignes disposent de leur restauration.
- Propriétés, titre non confirmé et affichage ne sont pas des brouillons persistants. Seul le corps Yjs survit à la fermeture hors ligne. Une nouvelle ouverture exige le réseau pour vérifier les droits.
- Aucune garantie d’effacement d’un export ou de la mémoire d’un navigateur totalement hors ligne. Les garanties portent sur la purge observée et l’absence de relecture/rejeu d’un ancien cache. Les marqueurs de déconnexion restent nécessaires.
- Pas de qualification à cinquante comptes ou nombreux onglets/caches accumulés. Les quotas restent identiques ; leur consommation devra être examinée en 6d. Aucun benchmark n’est requalifié ici ; les chiffres 6b restent leur propre preuve.
- Finition visuelle, essais matériels d’authentification et revue adverse consolidée ne sont pas déclarés terminés. Aucun risque n’est accepté à la place du développeur.

Description intermédiaire dans `.local/session-6c-pr.md`. Pas de PR créée ni de merge.
